import { parentPort, workerData } from "node:worker_threads";
import { writeFile, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { scan } from "./scanner.mjs";
import { loadFolderCache, saveFolderCache } from "./folder-cache.mjs";

const controller = new AbortController(),
  flag = new Int32Array(workerData.cancellation);
parentPort.on("message", (message) => {
  if (message === "abort") controller.abort();
});
const signal = {
  get aborted() {
    return Atomics.load(flag, 0) === 1;
  },
  addEventListener: (...args) => controller.signal.addEventListener(...args),
  removeEventListener: (...args) =>
    controller.signal.removeEventListener(...args),
};
try {
  const folderCache = await loadFolderCache(
    workerData.dataDir,
    workerData.options,
  );
  const result = await scan(workerData.options, {
    signal,
    folderCache,
    onProgress: (progress) =>
      parentPort.postMessage({ type: "progress", progress }),
  });
  if (result.folderSizing)
    try {
      await saveFolderCache(
        workerData.dataDir,
        workerData.options,
        folderCache,
        result,
      );
    } catch (e) {
      result.notices.push("Folder cache could not be saved: " + e.message);
    }
  try {
    const disk = await statfs(result.root);
    result.disk = {
      total: disk.blocks * disk.bsize,
      free: disk.bavail * disk.bsize,
    };
  } catch {}
  await writeFile(
    path.join(workerData.dataDir, result.id + ".json"),
    JSON.stringify(result),
  );
  const summary = {
    id: result.id,
    operation: "folder-sizes",
    root: result.root,
    name: result.name,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    totalBytes: result.totalBytes,
    opportunityBytes: result.opportunityBytes,
    fileCount: result.fileCount,
    durationMs: result.durationMs,
    findingCount: result.findings.length,
    coverageKey: createHash("sha256")
      .update(
        JSON.stringify({
          root: result.root,
          exclusions: [...result.options.exclusions].sort(),
          skipCloud: result.options.skipCloud,
          ...(result.folderSizing ? { operation: "folder-sizes" } : {}),
        }),
      )
      .digest("hex"),
  };
  parentPort.postMessage({ type: "done", summary });
} catch (e) {
  parentPort.postMessage({ type: "error", error: e.message });
} finally {
  parentPort.close();
}
