import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const validDate = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const absolute = (value) => typeof value === "string" && path.isAbsolute(value);

export function validateServiceEvidence(evidence, dataDir) {
  if (
    !evidence ||
    evidence.operatorControlsLaunchers !== true ||
    evidence.restartProhibitedUntilComplete !== true ||
    !validDate(evidence.recordedAt) ||
    !Array.isArray(evidence.services) ||
    !evidence.services.length
  )
    return false;
  const ids = new Set();
  for (const service of evidence.services) {
    if (
      !Number.isSafeInteger(service.pid) ||
      service.pid <= 0 ||
      ids.has(service.pid) ||
      !validDate(service.createdAt) ||
      !absolute(service.executablePath) ||
      !absolute(service.checkout) ||
      !absolute(service.dataDir) ||
      typeof service.commandLine !== "string" ||
      !service.commandLine.includes("index.mjs")
    )
      return false;
    ids.add(service.pid);
    if (
      !service.launchEvidence ||
      service.launchEvidence.source !== "verified-process-inspection" ||
      !validDate(service.launchEvidence.observedAt) ||
      service.launchEvidence.cwd !== service.checkout ||
      !(
        service.launchEvidence.RECLAIM_DATA_DIR === null ||
        absolute(service.launchEvidence.RECLAIM_DATA_DIR)
      )
    )
      return false;
    const configured =
      service.launchEvidence.RECLAIM_DATA_DIR ||
      path.join(service.checkout, ".reclaim");
    if (
      path.resolve(configured).toLowerCase() !==
      path.resolve(service.dataDir).toLowerCase()
    )
      return false;
    if (service.dataDir.toLowerCase() !== dataDir.toLowerCase()) return false;
    const idle = service.idle;
    if (
      !idle ||
      idle.product !== "reclaim" ||
      idle.job !== null ||
      idle.cleanupBusy !== false ||
      idle.measurementJob !== null ||
      idle.routineBusy !== false ||
      !validDate(idle.observedAt)
    )
      return false;
    if (
      !service.shutdown ||
      service.shutdown.authenticated !== true ||
      service.shutdown.status !== 200 ||
      !validDate(service.shutdown.at) ||
      !service.exit ||
      service.exit.observed !== true ||
      !validDate(service.exit.observedAt) ||
      !Array.isArray(service.workers)
    )
      return false;
    if (
      Date.parse(service.createdAt) > Date.parse(service.idle.observedAt) ||
      Date.parse(service.idle.observedAt) > Date.parse(service.shutdown.at) ||
      Date.parse(service.shutdown.at) > Date.parse(service.exit.observedAt)
    )
      return false;
    for (const worker of service.workers)
      if (
        !Number.isSafeInteger(worker.pid) ||
        !validDate(worker.createdAt) ||
        worker.exited !== true ||
        !validDate(worker.observedAt)
      )
        return false;
  }
  return true;
}

export const productionProcessAdapter = {
  validateEvidence: validateServiceEvidence,
  async observe(dataDir, evidence) {
    if (process.platform !== "win32")
      throw new Error("Production process observation requires Windows.");
    const script =
      "@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object Name,ProcessId,CreationDate,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
    const { stdout } = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const processes = Array.isArray(parsed) ? parsed : [parsed],
      candidates = [],
      ambiguous = [];
    const departed = new Set(
      (evidence?.services || []).flatMap((service) => [
        service.pid,
        ...service.workers.map((worker) => worker.pid),
      ]),
    );
    for (const processInfo of processes) {
      if (processInfo.ProcessId === process.pid) continue;
      if (departed.has(processInfo.ProcessId)) {
        candidates.push({ pid: processInfo.ProcessId });
        continue;
      }
      if (!/^(node|nodejs|electron)(\.exe)?$/i.test(processInfo.Name)) continue;
      const command = processInfo.CommandLine;
      if (!command || !processInfo.ExecutablePath) {
        ambiguous.push({ pid: processInfo.ProcessId });
        continue;
      }
      if (/reclaim|server[/\\]index\.mjs|scan-worker\.mjs/i.test(command))
        candidates.push({ pid: processInfo.ProcessId });
      // A different entrypoint (including an absolute module or package wrapper)
      // can import createApp and write the same data directory. Names are not
      // ownership evidence; every other Node/Electron process remains unknown.
      else ambiguous.push({ pid: processInfo.ProcessId });
    }
    return { candidates, ambiguous };
  },
};
