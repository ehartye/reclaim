import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMeasurementJobs } from "../server/opportunity-jobs.mjs";
test("read-only measurements run once, persist compact evidence and reject concurrent work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-measure-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "project", "dist");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "bundle.js"), Buffer.alloc(1024 ** 2, 1));
  const jobs = await createMeasurementJobs({
    dataDir: path.join(root, "state"),
  });
  t.after(() => jobs.close());
  const started = jobs.start([{ id: "test-target", path: target }]);
  assert(started.id);
  assert(jobs.getSnapshot().job);
  assert.throws(
    () => jobs.start([{ id: "test-target", path: target }]),
    /running/i,
  );
  await jobs.wait();
  const snapshot = jobs.getSnapshot();
  assert.equal(snapshot.job, null);
  assert.equal(snapshot.measurements["test-target"].status, "complete");
  assert.equal(snapshot.measurements["test-target"].logicalBytes, 1024 ** 2);
  await jobs.close();
  const restored = await createMeasurementJobs({
    dataDir: path.join(root, "state"),
  });
  t.after(() => restored.close());
  assert.equal(
    restored.getSnapshot().measurements["test-target"].logicalBytes,
    1024 ** 2,
  );
});
test("cancellation is explicit and close cleans up the active measurement helper", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-measure-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "data"), "keep");
  const jobs = await createMeasurementJobs({
    dataDir: path.join(root, "state"),
  });
  jobs.start([{ id: "cancel", path: root }]);
  jobs.cancel();
  await jobs.close();
  assert.equal(jobs.getSnapshot().job, null);
  assert.equal(jobs.getSnapshot().measurements.cancel.status, "cancelled");
});
