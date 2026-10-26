import { parentPort, workerData } from "node:worker_threads";
import { loadReportIndex } from "./opportunity-index.mjs";
const records = {},
  errors = [];
try {
  let done = 0;
  for (const summary of workerData.scans) {
    parentPort.postMessage({
      type: "progress",
      progress: { done, total: workerData.scans.length, current: summary.id },
    });
    try {
      const result = await loadReportIndex(summary, {
        dataDir: workerData.dataDir,
      });
      for (const [id, row] of Object.entries(result.records))
        if (
          !records[id] ||
          Date.parse(row.recordedAt) > Date.parse(records[id].recordedAt)
        )
          records[id] = row;
      if (result.error) errors.push(result.error);
    } catch (e) {
      errors.push(`${summary.id}: ${e.message}`);
    }
    done++;
    parentPort.postMessage({
      type: "progress",
      progress: { done, total: workerData.scans.length },
    });
  }
  parentPort.postMessage({
    type: "done",
    records,
    ...(errors.length
      ? {
          error:
            errors.slice(0, 10).join("; ") +
            (errors.length > 10
              ? `; ${errors.length - 10} more index failures`
              : ""),
        }
      : {}),
  });
} catch (e) {
  parentPort.postMessage({ type: "done", records, error: e.message });
} finally {
  parentPort.close();
}
