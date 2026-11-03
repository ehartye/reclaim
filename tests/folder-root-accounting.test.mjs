import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { rollupFolderRows } from "../server/folder-accounting.mjs";
test("filesystem root aggregates each descendant once without counting itself as a child", () => {
  const root = path.parse(path.resolve(".")).root,
    child = path.join(root, "child"),
    leaf = path.join(child, "leaf");
  const rows = new Map([
    [
      root,
      { path: root, bytes: 100, fileCount: 1, childCount: 1, complete: true },
    ],
    [
      child,
      { path: child, bytes: 200, fileCount: 2, childCount: 1, complete: true },
    ],
    [
      leaf,
      { path: leaf, bytes: 300, fileCount: 3, childCount: 0, complete: true },
    ],
  ]);
  assert.equal(rollupFolderRows(rows, [], "2026-10-25T00:00:00Z"), false);
  assert.equal(rows.get(root).bytes, 600);
  assert.equal(rows.get(root).fileCount, 6);
  assert.equal(rows.get(root).directoryCount, 3);
  assert.equal(rows.get(child).bytes, 500);
});
test("a cached filesystem root is not doubled and correct logical totals are never clamped to disk capacity", () => {
  const root = path.parse(path.resolve(".")).root,
    row = {
      path: root,
      bytes: 1200000000000,
      fileCount: 10,
      complete: true,
      estimated: true,
      cachedDirectories: 7,
      childCount: 0,
      measuredAt: "2026-10-25T00:00:00Z",
    };
  rollupFolderRows(new Map([[root, row]]), [], "2026-10-25T01:00:00Z");
  assert.equal(row.bytes, 1200000000000);
  assert.equal(row.directoryCount, 7);
  const report = {
    root,
    totalBytes: row.bytes,
    fileCount: 10,
    disk: { total: 1000000000000 },
    folderSizing: { accountingVersion: 2, minimumBytes: 0 },
    directories: [row],
  };
  assert.equal(row.bytes, 1200000000000);
});
test("saved filesystem-root folder report is not double counted in API or CSV and original evidence remains intact", async (t) => {
  const dataDir = await mkdtemp(
    path.join(tmpdir(), "reclaim-root-accounting-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const id = randomUUID(),
    root = path.parse(path.resolve(".")).root,
    child = path.join(root, "data");
  const report = {
    id,
    root,
    name: root,
    status: "completed",
    startedAt: "2026-10-25T00:00:00Z",
    completedAt: "2026-10-25T00:01:00Z",
    totalBytes: 820669515871,
    fileCount: 10,
    directoryCount: 2,
    findings: [],
    files: [],
    notices: [],
    options: { operation: "folder-sizes", exclusions: [], skipCloud: true },
    folderSizing: {
      accountingVersion: 2,
      minimumBytes: 500000000,
      basis: "logical-file-entries",
      scopeComplete: true,
      matchingCount: 2,
    },
    directories: [
      { path: root, bytes: 820669515871, fileCount: 10, directoryCount: 2 },
      { path: child, bytes: 500000000000, fileCount: 5, directoryCount: 1 },
    ],
  };
  const raw = JSON.stringify(report),
    file = path.join(dataDir, id + ".json");
  await writeFile(file, raw);
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({
      scans: [
        { id, root, totalBytes: report.totalBytes, operation: "folder-sizes" },
      ],
    }),
  );
  const app = await createApp({ dataDir });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/scans/${id}`;
  const response = await fetch(base).then((r) => r.json());
  assert.equal(response.directories[0].bytes, 820669515871);
  assert.equal(response.directories[0].fileCount, 10);
  assert.equal(response.directories[0].directoryCount, 2);
  assert.equal(response.directories[1].bytes, 500000000000);
  const csv = await fetch(base + "/report.csv").then((r) => r.text());
  assert(csv.includes("820669515871"));
  assert(!csv.includes("1641339031742"));
  assert.equal(await readFile(file, "utf8"), raw);
});
