import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScanJob } from "../server/jobs.mjs";
import { defaults } from "../server/scanner.mjs";

test("background scan jobs persist reports and accept cancellation without blocking the service", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "reclaim-jobs-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "folder");
  await mkdir(root);
  await writeFile(path.join(root, "file.bin"), "file content");
  let progress = false;
  const completed = await runScanJob({
    options: { ...defaults, root },
    dataDir,
    onProgress: () => {
      progress = true;
    },
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.fileCount, 1);
  assert(progress);
  const saved = JSON.parse(
    await readFile(path.join(dataDir, completed.id + ".json"), "utf8"),
  );
  assert.equal(saved.totalBytes, 12);
  assert(saved.disk);
  assert(completed.coverageKey);
  const controller = new AbortController();
  const cancelled = await runScanJob({
    options: { ...defaults, root },
    dataDir,
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  assert.equal(cancelled.status, "cancelled");
});
