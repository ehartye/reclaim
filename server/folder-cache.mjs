import { createHash, randomUUID } from "node:crypto";
import { open, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { latestChange } from "../shared/opportunities.ts";
export const FOLDER_CACHE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRecords: 25000,
});
// Limits apply before reading/serializing. A smaller cache only costs future recounts.
async function readBoundedJson(file) {
  const handle = await open(file, "r");
  try {
    if ((await handle.stat()).size > FOLDER_CACHE_LIMITS.maxBytes)
      throw new Error("Cache exceeds budget");
    const buffer = Buffer.alloc(FOLDER_CACHE_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > FOLDER_CACHE_LIMITS.maxBytes)
      throw new Error("Cache exceeds budget");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally {
    await handle.close();
  }
}
function compactRecord(row, fallbackDate) {
  if (
    !row ||
    row.complete !== true ||
    row.estimated ||
    typeof row.path !== "string" ||
    row.path.length > 32768
  )
    return null;
  if (
    ![
      row.bytes,
      row.fileCount,
      row.directoryCount,
      row.stamp,
      row.birthStamp,
    ].every(Number.isSafeInteger) ||
    row.bytes < 0 ||
    row.fileCount < 0 ||
    row.directoryCount < 1
  )
    return null;
  const measuredAt = row.measuredAt || fallbackDate;
  if (
    typeof measuredAt !== "string" ||
    measuredAt.length > 64 ||
    !Number.isFinite(Date.parse(measuredAt))
  )
    return null;
  return {
    path: row.path,
    bytes: row.bytes,
    fileCount: row.fileCount,
    directoryCount: row.directoryCount,
    stamp: row.stamp,
    birthStamp: row.birthStamp,
    measuredAt,
    hasGitFile: row.hasGitFile === true,
    complete: true,
    estimated: false,
  };
}
export function encodeFolderCache(
  previous,
  result,
  limits = FOLDER_CACHE_LIMITS,
) {
  const { maxBytes, maxRecords } = limits;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 26 ||
    maxBytes > FOLDER_CACHE_LIMITS.maxBytes ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 0 ||
    maxRecords > FOLDER_CACHE_LIMITS.maxRecords
  )
    throw new Error("Invalid cache budget");
  const remaining = new Map();
  for (const row of previous.slice(0, maxRecords)) {
    const record = compactRecord(row);
    if (record) remaining.set(record.path, record);
  }
  const prefix = '{"version":1,"records":[';
  const chunks = [];
  let bytes = Buffer.byteLength(prefix) + 2;
  const append = (record) => {
    if (!record || chunks.length >= maxRecords) return;
    const json = JSON.stringify(record);
    const size = Buffer.byteLength(json) + (chunks.length ? 1 : 0);
    if (bytes + size > maxBytes) return;
    chunks.push(json);
    bytes += size;
  };
  for (const row of result.directories) {
    // Still process invalidation after the output budget is full.
    if (!row.complete || !row.estimated) remaining.delete(row.path);
    if (!row.estimated && chunks.length < maxRecords)
      append(compactRecord(row, result.startedAt));
  }
  for (const row of remaining.values()) append(row);
  return prefix + chunks.join(",") + "]}";
}
function cachePath(dataDir, options) {
  const key = JSON.stringify({
    root: path.resolve(options.root),
    exclusions: [...(options.exclusions || [])].sort(),
    skipCloud: options.skipCloud !== false,
  });
  return path.join(
    dataDir,
    "intelligence",
    "folders-" + createHash("sha256").update(key).digest("hex") + ".json",
  );
}
export async function loadFolderCache(dataDir, options) {
  try {
    const data = await readBoundedJson(cachePath(dataDir, options));
    let changes = [];
    try {
      const state = await readBoundedJson(path.join(dataDir, "state.json"));
      changes = (state.cleanups || []).map((r) => ({
        path: r.path,
        changedAt: Date.parse(r.completedAt || r.startedAt),
      }));
    } catch (error) {
      if (error.code !== "ENOENT") return [];
    }
    return data.version === 1 && Array.isArray(data.records)
      ? data.records
          .slice(0, FOLDER_CACHE_LIMITS.maxRecords)
          .map((r) => compactRecord(r))
          .filter(
            (r) => r && typeof r === "object" && typeof r.path === "string",
          )
          .filter((r) => {
            const changedAt = latestChange(r.path, changes);
            return !changedAt || Date.parse(r.measuredAt) > changedAt;
          })
      : [];
  } catch {
    return [];
  }
}
export async function saveFolderCache(dataDir, options, previous, result) {
  const encoded = encodeFolderCache(previous, result);
  const file = cachePath(dataDir, options);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, encoded, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
