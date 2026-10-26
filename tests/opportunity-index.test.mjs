import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  compactReport,
  createOpportunityIndex,
} from "../server/opportunity-index.mjs";
import { targetId } from "../server/development.mjs";
import { runScanJob } from "../server/jobs.mjs";
import { defaults } from "../server/scanner.mjs";

const ids = {
  old: "11111111-1111-4111-8111-111111111111",
  new: "22222222-2222-4222-8222-222222222222",
};
function report(
  root,
  {
    id = ids.old,
    completedAt = "2026-01-01T00:00:00.000Z",
    status = "completed",
    count = 2,
  } = {},
) {
  const target = path.join(root, "app", "node_modules"),
    files = Array.from({ length: count }, (_, i) => ({
      path: path.join(target, `file-${i}.bin`),
      size: 10,
      mtimeMs: i === count - 1 ? 2000 : 1000,
      nlink: 1,
      identity: `1:${i}`,
    }));
  return {
    id,
    root,
    status,
    completedAt,
    findings: [
      {
        path: target,
        category: "dependencies",
        filePaths: files.map((f) => f.path),
        fileCount: count,
        bytes: count * 10,
        modifiedAt: 1000,
      },
    ],
    files,
  };
}
const summary = (r) => ({
  id: r.id,
  root: r.root,
  status: r.status,
  completedAt: r.completedAt,
  fileCount: r.files.length,
  findingCount: r.findings.length,
});
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-index-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function ready(index) {
  for (let i = 0; i < 400; i++) {
    const s = index.getSnapshot();
    if (s.status !== "building") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Index did not finish");
}

test("compact index uses all member timestamps, discounts shared hardlinks and leaves reports unchanged", () => {
  const r = report(path.resolve("fixture"), { count: 10002 }),
    target = r.findings[0].path;
  r.files[0].nlink = 2;
  const before = JSON.stringify(r),
    records = compactReport(r),
    row = records[targetId(target)];
  assert.equal(row.newestWriteAt, 2000);
  assert.equal(row.logicalBytes, 100020);
  assert.equal(row.exclusiveLogicalBytes, 100010);
  assert.equal(row.sharedLogicalBytes, 10);
  assert.equal(row.coverageComplete, true);
  assert.equal(JSON.stringify(r), before);
});
test("partial or malformed coverage cannot establish an old complete target", () => {
  const r = report(path.resolve("fixture"), { status: "partial" }),
    key = targetId(r.findings[0].path);
  assert.equal(compactReport(r)[key].coverageComplete, false);
  r.status = "completed";
  r.files[1].mtimeMs = undefined;
  const missing = compactReport(r)[key];
  assert.equal(missing.coverageComplete, false);
  assert.equal(missing.newestWriteAt, null);
  r.files.pop();
  assert.equal(compactReport(r)[key].newestWriteAt, null);
});
test("duplicate metadata and shared identities cannot inflate gain or establish a reliable age", () => {
  const r = report(path.resolve("fixture")),
    key = targetId(r.findings[0].path);
  r.files.push({ ...r.files[0], mtimeMs: 999999 });
  const duplicate = compactReport(r)[key];
  assert.equal(duplicate.logicalBytes, 20);
  assert.equal(duplicate.coverageComplete, false);
  assert.equal(duplicate.newestWriteAt, null);
  r.files.pop();
  r.files[0].nlink = 2;
  r.files[1].nlink = 2;
  r.files[1].identity = r.files[0].identity;
  const shared = compactReport(r)[key];
  assert.equal(shared.logicalBytes, 10);
  assert.equal(shared.sharedLogicalBytes, 10);
  assert.equal(shared.exclusiveLogicalBytes, 0);
  assert.equal(shared.coverageComplete, false);
});
test("lazy worker indexes latest snapshots, caches sidecars and preserves raw bytes", async (t) => {
  const dataDir = await fixture(t),
    root = path.join(dataDir, "workspace"),
    old = report(root),
    newer = report(root, {
      id: ids.new,
      completedAt: "2026-02-01T00:00:00.000Z",
      status: "partial",
    });
  newer.files[0].size = 30;
  newer.findings[0].bytes = 40;
  const oldRaw = JSON.stringify(old),
    newRaw = JSON.stringify(newer);
  await writeFile(path.join(dataDir, old.id + ".json"), oldRaw);
  await writeFile(path.join(dataDir, newer.id + ".json"), newRaw);
  const index = createOpportunityIndex({ dataDir });
  t.after(() => index.close());
  index.ensure([summary(old)]);
  assert.equal(index.getSnapshot().status, "building");
  let s = await ready(index);
  assert.equal(s.status, "ready");
  index.ensure([summary(newer), summary(old)]);
  s = await ready(index);
  const row = s.records[targetId(old.findings[0].path)];
  assert.equal(row.scanId, ids.new);
  assert.equal(row.logicalBytes, 40);
  assert.equal(row.coverageComplete, false);
  const cache = path.join(dataDir, "intelligence", old.id + ".json"),
    stamp = (await stat(cache)).mtimeMs;
  await index.close();
  const reused = createOpportunityIndex({ dataDir });
  t.after(() => reused.close());
  reused.ensure([summary(old)]);
  assert.equal((await ready(reused)).status, "ready");
  assert.equal((await stat(cache)).mtimeMs, stamp);
  assert.equal(
    await readFile(path.join(dataDir, old.id + ".json"), "utf8"),
    oldRaw,
  );
  assert.equal(
    await readFile(path.join(dataDir, newer.id + ".json"), "utf8"),
    newRaw,
  );
});
test("invalid cache versions and target keys are rebuilt, unsafe scan IDs rejected", async (t) => {
  const dataDir = await fixture(t),
    r = report(path.join(dataDir, "root"));
  await writeFile(path.join(dataDir, r.id + ".json"), JSON.stringify(r));
  const index = createOpportunityIndex({ dataDir });
  t.after(() => index.close());
  assert.throws(
    () => index.ensure([{ ...summary(r), id: "../escape" }]),
    /scan/i,
  );
  index.ensure([summary(r)]);
  await ready(index);
  await index.close();
  const cache = path.join(dataDir, "intelligence", r.id + ".json"),
    corrupt = JSON.parse(await readFile(cache, "utf8"));
  corrupt.version = -1;
  corrupt.records = {
    fake: { path: path.parse(dataDir).root, logicalBytes: 1 },
  };
  await writeFile(cache, JSON.stringify(corrupt));
  const rebuilt = createOpportunityIndex({ dataDir });
  t.after(() => rebuilt.close());
  rebuilt.ensure([summary(r)]);
  const s = await ready(rebuilt);
  assert.equal(s.status, "ready");
  assert(s.records[targetId(r.findings[0].path)]);
  assert(!s.records.fake);
  await rebuilt.close();
  const wrongKey = JSON.parse(await readFile(cache, "utf8"));
  wrongKey.records.fake = Object.values(wrongKey.records)[0];
  delete wrongKey.records[targetId(r.findings[0].path)];
  await writeFile(cache, JSON.stringify(wrongKey));
  const corrected = createOpportunityIndex({ dataDir });
  t.after(() => corrected.close());
  corrected.ensure([summary(r)]);
  const correctedSnapshot = await ready(corrected);
  assert(correctedSnapshot.records[targetId(r.findings[0].path)]);
  assert(!correctedSnapshot.records.fake);
});
test("empty history is ready and closing active indexing settles without an unhandled failure", async (t) => {
  const dataDir = await fixture(t),
    index = createOpportunityIndex({ dataDir });
  index.ensure([]);
  assert.equal(index.getSnapshot().status, "ready");
  const r = report(path.join(dataDir, "root"));
  await writeFile(path.join(dataDir, r.id + ".json"), JSON.stringify(r));
  index.ensure([summary(r)]);
  assert.equal(index.getSnapshot().status, "building");
  await index.close();
  assert.notEqual(index.getSnapshot().status, "building");
});
test("changed source files invalidate a valid cache without altering the report", async (t) => {
  const dataDir = await fixture(t),
    r = report(path.join(dataDir, "root")),
    file = path.join(dataDir, r.id + ".json");
  await writeFile(file, JSON.stringify(r));
  const index = createOpportunityIndex({ dataDir });
  index.ensure([summary(r)]);
  await ready(index);
  await index.close();
  r.files[0].size = 40;
  r.findings[0].bytes = 50;
  const source = JSON.stringify(r);
  await writeFile(file, source);
  const refreshed = createOpportunityIndex({ dataDir });
  t.after(() => refreshed.close());
  refreshed.ensure([summary(r)]);
  const s = await ready(refreshed);
  assert.equal(s.records[targetId(r.findings[0].path)].logicalBytes, 50);
  assert.equal(await readFile(file, "utf8"), source);
});
test("new scan workers create compact sidecars and a cache failure does not lose a saved scan", async (t) => {
  for (const blocked of [false, true]) {
    const dataDir = await fixture(t),
      root = path.join(dataDir, "workspace");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "node_modules", "file.bin"), "generated");
    if (blocked)
      await writeFile(path.join(dataDir, "intelligence"), "not a directory");
    const completed = await runScanJob({
      options: { ...defaults, root, minimumBytes: 1 },
      dataDir,
    });
    assert.equal(completed.status, "completed");
    const raw = JSON.parse(
      await readFile(path.join(dataDir, completed.id + ".json"), "utf8"),
    );
    assert.equal(raw.id, completed.id);
    if (!blocked) {
      const sidecar = JSON.parse(
        await readFile(
          path.join(dataDir, "intelligence", completed.id + ".json"),
          "utf8",
        ),
      );
      assert.equal(
        sidecar.records[targetId(path.join(root, "node_modules"))].logicalBytes,
        9,
      );
    }
  }
});
test("a bad report does not discard valid indexed snapshots from other reports", async (t) => {
  const dataDir = await fixture(t),
    r = report(path.join(dataDir, "root"));
  await writeFile(path.join(dataDir, r.id + ".json"), JSON.stringify(r));
  await writeFile(path.join(dataDir, ids.new + ".json"), "{broken");
  const index = createOpportunityIndex({ dataDir });
  t.after(() => index.close());
  index.ensure([summary(r), { ...summary(r), id: ids.new }]);
  const s = await ready(index);
  assert.equal(s.status, "error");
  assert.match(s.error, new RegExp(ids.new));
  assert(s.records[targetId(r.findings[0].path)]);
});
