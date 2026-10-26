import { Worker } from "node:worker_threads";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { targetId, within } from "./development.mjs";

export const OPPORTUNITY_INDEX_VERSION = 1;
const key = (p) => path.resolve(p).toLowerCase();
const bytes = (n) => Number.isSafeInteger(n) && n >= 0;
const timestamp = (n) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 8.64e15;
export function validateScanSummary(summary) {
  if (
    !summary ||
    typeof summary.id !== "string" ||
    !/^[a-f\d-]{1,80}$/i.test(summary.id) ||
    typeof summary.root !== "string" ||
    !path.isAbsolute(summary.root) ||
    typeof summary.completedAt !== "string" ||
    !Number.isFinite(Date.parse(summary.completedAt)) ||
    typeof summary.status !== "string"
  )
    throw new Error("Invalid saved scan summary for opportunity indexing.");
  return {
    id: summary.id,
    root: path.resolve(summary.root),
    status: summary.status,
    completedAt: summary.completedAt,
  };
}
export function compactReport(report) {
  const summary = validateScanSummary(report),
    records = {},
    members = new Map(),
    accumulators = [];
  for (const finding of report.findings || []) {
    if (
      !["builds", "dependencies", "caches"].includes(finding.category) ||
      typeof finding.path !== "string" ||
      !path.isAbsolute(finding.path) ||
      !within(path.resolve(finding.path), summary.root)
    )
      continue;
    const id = targetId(finding.path),
      record = {
        path: path.resolve(finding.path),
        recordedAt: summary.completedAt,
        scanId: summary.id,
        scanStatus: summary.status,
        logicalBytes: 0,
        exclusiveLogicalBytes: 0,
        sharedLogicalBytes: 0,
        fileCount: 0,
        newestWriteAt: null,
        coverageComplete: summary.status === "completed",
      };
    if (records[id]) {
      records[id].coverageComplete = false;
      const existing = accumulators.find((a) => a.record === records[id]);
      if (existing) existing.badTime = true;
      continue;
    }
    const acc = {
      record,
      wantedCount: 0,
      observedCount: 0,
      seenIdentities: new Set(),
      badTime: false,
    };
    records[id] = record;
    accumulators.push(acc);
    if (!Array.isArray(finding.filePaths) || !finding.filePaths.length)
      record.coverageComplete = false;
    for (const p of finding.filePaths || []) {
      if (
        typeof p !== "string" ||
        !path.isAbsolute(p) ||
        !within(path.resolve(p), record.path)
      ) {
        record.coverageComplete = false;
        acc.badTime = true;
        continue;
      }
      const member = key(p),
        entry = members.get(member) || { owners: [], seen: false };
      if (entry.owners.includes(acc)) {
        record.coverageComplete = false;
        acc.badTime = true;
        continue;
      }
      entry.owners.push(acc);
      members.set(member, entry);
      acc.wantedCount++;
    }
    if (
      !Number.isSafeInteger(finding.fileCount) ||
      finding.fileCount !== acc.wantedCount
    )
      record.coverageComplete = false;
    for (const skipped of [...(report.skipped || []), ...(report.errors || [])])
      if (
        typeof skipped.path === "string" &&
        within(path.resolve(skipped.path), record.path) &&
        !/hardlink already counted/i.test(skipped.reason || "")
      ) {
        record.coverageComplete = false;
        acc.badTime = true;
      }
  }
  for (const file of report.files || []) {
    if (typeof file?.path !== "string") continue;
    const member = key(file.path),
      entry = members.get(member);
    if (!entry) continue;
    if (entry.seen) {
      for (const acc of entry.owners) {
        acc.record.coverageComplete = false;
        acc.badTime = true;
      }
      continue;
    }
    entry.seen = true;
    for (const acc of entry.owners) {
      const r = acc.record;
      acc.observedCount++;
      if (!bytes(file.size)) {
        r.coverageComplete = false;
        acc.badTime = true;
        continue;
      }
      const identity =
        typeof file.identity === "string" && file.identity
          ? file.identity
          : member;
      if (acc.seenIdentities.has(identity)) {
        r.coverageComplete = false;
        acc.badTime = true;
        continue;
      }
      acc.seenIdentities.add(identity);
      r.logicalBytes += file.size;
      r.fileCount++;
      if (file.nlink === 1) r.exclusiveLogicalBytes += file.size;
      else if (Number.isInteger(file.nlink) && file.nlink > 1)
        r.sharedLogicalBytes += file.size;
      else r.coverageComplete = false;
      if (timestamp(file.mtimeMs))
        r.newestWriteAt = Math.max(r.newestWriteAt ?? 0, file.mtimeMs);
      else {
        acc.badTime = true;
        r.coverageComplete = false;
      }
    }
  }
  for (const { record, wantedCount, observedCount, badTime } of accumulators) {
    if (observedCount !== wantedCount) {
      record.coverageComplete = false;
      record.newestWriteAt = null;
    }
    if (badTime) record.newestWriteAt = null;
    if (
      !bytes(record.logicalBytes) ||
      !bytes(record.exclusiveLogicalBytes) ||
      !bytes(record.sharedLogicalBytes)
    ) {
      record.coverageComplete = false;
      record.logicalBytes = 0;
      record.exclusiveLogicalBytes = 0;
      record.sharedLogicalBytes = 0;
      record.newestWriteAt = null;
    }
  }
  return records;
}
function summaryMatches(a, b) {
  return (
    a?.id === b.id &&
    typeof a.root === "string" &&
    key(a.root) === key(b.root) &&
    a.status === b.status &&
    a.completedAt === b.completedAt
  );
}
function validRecords(records, summary) {
  if (!records || typeof records !== "object" || Array.isArray(records))
    return false;
  return Object.entries(records).every(
    ([id, r]) =>
      r &&
      typeof r.path === "string" &&
      path.isAbsolute(r.path) &&
      within(path.resolve(r.path), summary.root) &&
      id === targetId(r.path) &&
      r.scanId === summary.id &&
      r.scanStatus === summary.status &&
      r.recordedAt === summary.completedAt &&
      bytes(r.logicalBytes) &&
      bytes(r.exclusiveLogicalBytes) &&
      bytes(r.sharedLogicalBytes) &&
      r.exclusiveLogicalBytes + r.sharedLogicalBytes <= r.logicalBytes &&
      bytes(r.fileCount) &&
      (r.newestWriteAt === null || timestamp(r.newestWriteAt)) &&
      typeof r.coverageComplete === "boolean" &&
      (!r.coverageComplete || summary.status === "completed"),
  );
}
async function reportSource(dataDir, id) {
  const info = await stat(path.join(dataDir, id + ".json"), { bigint: true });
  if (!info.isFile()) throw new Error("Saved scan report is not a file.");
  return {
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}
function equalSource(a, b) {
  return (
    a?.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}
async function persistReportIndex(records, source, summary, dataDir) {
  const dir = path.join(dataDir, "intelligence");
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, summary.id + "." + randomUUID() + ".tmp");
  await writeFile(
    temporary,
    JSON.stringify({
      version: OPPORTUNITY_INDEX_VERSION,
      summary,
      source,
      records,
    }),
  );
  await rename(temporary, path.join(dir, summary.id + ".json"));
  return records;
}
export async function writeReportIndex(
  report,
  { dataDir, summary: inputSummary } = {},
) {
  const summary = validateScanSummary(inputSummary || report);
  if (!summaryMatches(report, summary))
    throw new Error("Saved report does not match its scan summary.");
  const source = await reportSource(dataDir, summary.id),
    records = compactReport(report);
  return persistReportIndex(records, source, summary, dataDir);
}
export async function loadReportIndex(
  summaryInput,
  { dataDir, cacheOnly = false } = {},
) {
  const summary = validateScanSummary(summaryInput),
    source = await reportSource(dataDir, summary.id),
    cache = path.join(dataDir, "intelligence", summary.id + ".json");
  try {
    const saved = JSON.parse(await readFile(cache, "utf8"));
    if (
      saved.version === OPPORTUNITY_INDEX_VERSION &&
      summaryMatches(saved.summary, summary) &&
      equalSource(saved.source, source) &&
      validRecords(saved.records, summary)
    )
      return { records: saved.records };
  } catch {}
  if (cacheOnly) return null;
  const report = JSON.parse(
    await readFile(path.join(dataDir, summary.id + ".json"), "utf8"),
  );
  if (!equalSource(source, await reportSource(dataDir, summary.id)))
    throw new Error(
      "Saved report changed while its opportunity index was being built.",
    );
  if (!summaryMatches(report, summary))
    throw new Error("Saved report does not match its scan summary.");
  const records = compactReport(report);
  try {
    await persistReportIndex(records, source, summary, dataDir);
    return { records };
  } catch (e) {
    return {
      records,
      error: "Opportunity cache could not be saved: " + e.message,
    };
  }
}
export function createOpportunityIndex({ dataDir }) {
  let current = {
      status: "idle",
      progress: { done: 0, total: 0 },
      records: {},
    },
    active = null,
    desired = null,
    completedSignature = null,
    closed = false;
  const signature = (scans) =>
    createHash("sha256").update(JSON.stringify(scans)).digest("hex");
  function start(request) {
    if (closed) return;
    if (!request.scans.length) {
      completedSignature = request.signature;
      current = {
        status: "ready",
        progress: { done: 0, total: 0 },
        records: {},
      };
      return;
    }
    current = {
      status: "building",
      progress: { done: 0, total: request.scans.length },
      records: current.records,
    };
    let worker;
    try {
      worker = new Worker(
        new URL("./opportunity-index-worker.mjs", import.meta.url),
        {
          workerData: { dataDir, scans: request.scans },
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 2048 },
        },
      );
    } catch (e) {
      current = { ...current, status: "error", error: e.message };
      return;
    }
    const job = { worker, request, settled: false };
    active = job;
    const finish = (records, error) => {
      if (job.settled) return;
      job.settled = true;
      if (active === job) active = null;
      if (!closed) {
        completedSignature = request.signature;
        current = {
          status: error ? "error" : "ready",
          progress: { done: request.scans.length, total: request.scans.length },
          records: records || current.records,
          ...(error ? { error } : {}),
        };
        if (desired && desired.signature !== request.signature) start(desired);
      }
    };
    worker.on("message", (message) => {
      if (closed || job.settled) return;
      if (message.type === "progress")
        current = { ...current, progress: message.progress };
      else if (message.type === "done") finish(message.records, message.error);
    });
    worker.on("error", (e) => finish(null, e.message));
    worker.on("exit", (code) => {
      if (!job.settled)
        finish(
          null,
          `Opportunity index worker exited before completing (${code}).`,
        );
    });
  }
  return {
    ensure(scans) {
      if (closed) return;
      if (!Array.isArray(scans)) throw new Error("Invalid saved scan list.");
      const normalized = scans
        .map(validateScanSummary)
        .sort(
          (a, b) =>
            Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
            a.id.localeCompare(b.id),
        );
      if (new Set(normalized.map((s) => s.id)).size !== normalized.length)
        throw new Error("Duplicate saved scan IDs.");
      const request = { scans: normalized, signature: signature(normalized) };
      desired = request;
      if (!active && completedSignature !== request.signature) start(request);
    },
    getSnapshot() {
      return {
        ...current,
        progress: { ...current.progress },
        records: { ...current.records },
      };
    },
    async close() {
      closed = true;
      desired = null;
      const job = active;
      active = null;
      if (job) {
        job.settled = true;
        await job.worker.terminate();
      }
      current = {
        ...current,
        status: current.status === "building" ? "idle" : current.status,
      };
    },
  };
}
