import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { lstat, opendir, realpath } from "node:fs/promises";
import nodePath from "node:path";

function blank(path) {
  return {
    path,
    measuredAt: new Date().toISOString(),
    status: "partial",
    logicalBytes: 0,
    allocatedBytes: null,
    exclusiveAllocatedBytes: null,
    sharedAllocatedBytes: null,
    fileCount: 0,
    newestActivityAt: null,
    skippedCount: 0,
    errorCount: 0,
    notices: [],
    basis: "logical-only",
  };
}
const safeNumber = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
function normalizeProgress(message, base) {
  const next = { ...base };
  for (const key of ["logicalBytes", "fileCount", "skippedCount", "errorCount"])
    if (safeNumber(message[key])) next[key] = message[key];
  for (const key of [
    "allocatedBytes",
    "exclusiveAllocatedBytes",
    "sharedAllocatedBytes",
    "newestActivityAt",
  ])
    if (message[key] === null || safeNumber(message[key]))
      next[key] = message[key];
  if (next.allocatedBytes !== null) next.basis = "allocated";
  return next;
}
async function windowsMeasure({ path, signal, timeoutMs, onProgress }) {
  let result = blank(path),
    outcome = null,
    stderr = "",
    aborted = false,
    timedOut = false,
    protocolError = false;
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./windows-measure-folder.ps1", import.meta.url)),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const terminate = () => {
    aborted = true;
    child.kill();
  };
  signal?.addEventListener("abort", terminate, { once: true });
  if (signal?.aborted) terminate();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const completed = new Promise((resolve) => {
    child.once("error", (e) => {
      stderr = e.message;
      resolve(null);
    });
    child.once("close", (code) => resolve(code));
  });
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(0, 4000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ path, timeoutMs }) + "\n");
  try {
    for await (const line of createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === "progress") {
          result = normalizeProgress(message, result);
          onProgress({ ...result, status: "partial" });
        } else if (message.type === "result" && message.result)
          outcome = message.result;
        else protocolError = true;
      } catch {
        protocolError = true;
      }
    }
    const code = await completed;
    if (outcome)
      result = {
        ...normalizeProgress(outcome, result),
        path,
        measuredAt: outcome.measuredAt || result.measuredAt,
        status: outcome.status === "complete" ? "complete" : "partial",
        notices: Array.isArray(outcome.notices)
          ? outcome.notices.map(String)
          : [],
        basis: outcome.basis === "allocated" ? "allocated" : "logical-only",
      };
    if (aborted) {
      result.status = "cancelled";
      result.notices.push(
        "Measurement cancelled; totals and activity are incomplete.",
      );
    } else if (timedOut) {
      result.status = "partial";
      result.notices.push(
        "Measurement time budget reached; totals and activity are incomplete.",
      );
    } else if (code !== 0 || !outcome || protocolError) {
      result.status = "partial";
      result.errorCount++;
      result.notices.push(
        "Folder metadata helper did not complete: " +
          (stderr.trim() || "No valid result was returned."),
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", terminate);
    child.kill();
  }
}
async function portableMeasure({ path, signal, timeoutMs, onProgress }) {
  const result = blank(path),
    seen = new Set(),
    started = Date.now();
  let limit = false;
  result.status = "complete";
  result.basis = "allocated";
  result.allocatedBytes = 0;
  result.exclusiveAllocatedBytes = 0;
  result.sharedAllocatedBytes = 0;
  result.notices.push(
    "Potential gain is an estimate of allocated data, not guaranteed free space. Directory metadata and alternate streams are not included.",
    "Known shared hardlinks are excluded from exclusive potential gain.",
    "Activity is newest observed creation or write time, not last use or an exact build/install date.",
  );
  function activity(st) {
    if (Number(st.birthtimeMs) <= 0) {
      result.status = "partial";
      if (
        !result.notices.includes(
          "Creation timestamp is unavailable; generated age cannot be verified.",
        )
      )
        result.notices.push(
          "Creation timestamp is unavailable; generated age cannot be verified.",
        );
    }
    const newest = Math.max(Number(st.birthtimeMs), Number(st.mtimeMs));
    if (safeNumber(newest))
      result.newestActivityAt = Math.max(result.newestActivityAt || 0, newest);
  }
  function stop() {
    if (signal?.aborted) {
      result.status = "cancelled";
      limit = true;
      return true;
    }
    if (Date.now() - started >= timeoutMs || result.fileCount >= 2000000) {
      result.status = "partial";
      result.notices.push(
        "Measurement time or two-million-file budget reached; totals and activity are incomplete.",
      );
      limit = true;
      return true;
    }
    return false;
  }
  async function visit(target) {
    if (stop()) return;
    try {
      const st = await lstat(target, { bigint: true });
      activity(st);
      if (st.isSymbolicLink()) {
        result.status = "partial";
        result.skippedCount++;
        if (!result.notices.includes("Links and junctions were not followed."))
          result.notices.push("Links and junctions were not followed.");
        return;
      }
      if (st.isDirectory()) {
        const dir = await opendir(target);
        for await (const entry of dir) {
          if (stop()) break;
          await visit(nodePath.join(target, entry.name));
        }
        return;
      }
      if (!st.isFile()) {
        result.status = "partial";
        result.skippedCount++;
        return;
      }
      const identity = `${st.dev}:${st.ino}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      result.logicalBytes += Number(st.size);
      result.fileCount++;
      const blocks = Number(st.blocks);
      if (
        Number.isFinite(blocks) &&
        blocks >= 0 &&
        st.ino > 0n &&
        st.nlink > 0n &&
        result.allocatedBytes !== null
      ) {
        const allocated = blocks * 512;
        result.allocatedBytes += allocated;
        if (st.nlink === 1n) result.exclusiveAllocatedBytes += allocated;
        else result.sharedAllocatedBytes += allocated;
      } else {
        result.basis = "logical-only";
        result.allocatedBytes = null;
        result.exclusiveAllocatedBytes = null;
        result.sharedAllocatedBytes = null;
        result.status = "partial";
        if (
          !result.notices.includes(
            "Allocated size or filesystem identity is unavailable.",
          )
        )
          result.notices.push(
            "Allocated size or filesystem identity is unavailable.",
          );
      }
      if (result.fileCount % 1000 === 0)
        onProgress({ ...result, status: "partial" });
    } catch (e) {
      result.status = "partial";
      result.errorCount++;
      if (result.notices.length < 32)
        result.notices.push(
          "Folder not found or metadata inspection failed: " + e.message,
        );
    }
  }
  try {
    for (let current = path; ; current = nodePath.dirname(current)) {
      const st = await lstat(current);
      if (st.isSymbolicLink())
        throw new Error("Linked or junction ancestor cannot be measured.");
      if (nodePath.dirname(current) === current) break;
    }
    if ((await realpath(path)) !== path)
      throw new Error("Linked ancestor cannot be measured.");
    const root = await lstat(path);
    if (!root.isDirectory()) throw new Error("Choose a folder.");
    await visit(path);
  } catch (e) {
    result.status = "partial";
    result.errorCount++;
    result.notices.push(
      "Folder not found or metadata inspection failed: " + e.message,
    );
  }
  if (limit && signal?.aborted)
    result.notices.push(
      "Measurement cancelled; totals and activity are incomplete.",
    );
  return result;
}
export async function measureFolder({
  path,
  signal,
  timeoutMs = 60000,
  onProgress = () => {},
}) {
  const result = blank(path);
  if (
    typeof path !== "string" ||
    !nodePath.isAbsolute(path) ||
    path.includes("\0")
  ) {
    result.errorCount = 1;
    result.notices.push("Choose an absolute folder path.");
    return result;
  }
  path = nodePath.resolve(path);
  result.path = path;
  if (signal?.aborted) {
    result.status = "cancelled";
    result.notices.push("Measurement cancelled before inspection.");
    return result;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("Use a finite nonnegative measurement time budget.");
  if (timeoutMs === 0) {
    result.notices.push("Measurement time budget reached before inspection.");
    return result;
  }
  if (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(path)) {
    result.errorCount = 1;
    result.notices.push("Only local drive folder paths are supported.");
    return result;
  }
  return process.platform === "win32"
    ? windowsMeasure({ path, signal, timeoutMs, onProgress })
    : portableMeasure({ path, signal, timeoutMs, onProgress });
}
