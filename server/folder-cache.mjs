import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { latestChange } from "../shared/opportunities.ts";
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
    const data = JSON.parse(
      await readFile(cachePath(dataDir, options), "utf8"),
    );
    let changes = [];
    try {
      const state = JSON.parse(
        await readFile(path.join(dataDir, "state.json"), "utf8"),
      );
      changes = (state.cleanups || []).map((r) => ({
        path: r.path,
        changedAt: Date.parse(r.completedAt || r.startedAt),
      }));
    } catch {}
    return data.version === 1 && Array.isArray(data.records)
      ? data.records
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
  const records = new Map(previous.map((r) => [r.path, r]));
  for (const row of result.directories) {
    if (row.estimated) continue;
    if (row.complete)
      records.set(row.path, {
        ...row,
        measuredAt: row.measuredAt || result.startedAt,
      });
    else records.delete(row.path);
  }
  const file = cachePath(dataDir, options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file + ".tmp",
    JSON.stringify({ version: 1, records: [...records.values()] }),
  );
  await rename(file + ".tmp", file);
}
