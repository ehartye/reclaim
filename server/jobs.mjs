import { Worker } from "node:worker_threads";

export function runScanJob({
  options,
  dataDir,
  signal,
  onProgress = () => {},
}) {
  const cancellation = new SharedArrayBuffer(4),
    flag = new Int32Array(cancellation);
  const worker = new Worker(new URL("./scan-worker.mjs", import.meta.url), {
    workerData: { options, dataDir, cancellation },
    execArgv: [],
  });
  const abort = () => {
    Atomics.store(flag, 0, 1);
    worker.postMessage("abort");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return new Promise((resolve, reject) => {
    let settled = false;
    worker.on("message", (message) => {
      if (message.type === "progress") onProgress(message.progress);
      else if (message.type === "done") {
        settled = true;
        resolve(message.summary);
      } else if (message.type === "error") {
        settled = true;
        reject(new Error(message.error));
      }
    });
    worker.on("error", (e) => {
      settled = true;
      reject(e);
    });
    worker.on("exit", (code) => {
      if (!settled)
        reject(
          new Error(`Scan worker exited before saving a report (${code}).`),
        );
    });
  }).finally(() => signal?.removeEventListener("abort", abort));
}
