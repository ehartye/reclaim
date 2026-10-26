import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, symlink, link } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { scan } from "../server/scanner.mjs";
import { inspectFolderFiles } from "../server/folder-scan.mjs";
async function sized(file, size) {
  await mkdir(path.dirname(file), { recursive: true });
  const h = await open(file, "w");
  try {
    await h.truncate(size);
  } finally {
    await h.close();
  }
}
test("folder totals scan includes every nested folder strictly over500MB without individual file records or file cap", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-folder-é-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++)
    await sized(
      path.join(root, "arbitrary", "node_modules", "package", `file${i}`),
      200000000,
    );
  await sized(path.join(root, "equal", "a"), 400000000);
  await sized(path.join(root, "equal", "b"), 100000000);
  await sized(path.join(root, "small", "data"), 100);
  const result = await scan({
    root,
    operation: "folder-sizes",
    folderMinBytes: 500000000,
    maxFiles: 1,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.files.length, 0);
  assert.equal(result.fileCount, 6);
  assert.equal(result.totalBytes, 1100000100);
  assert.equal(result.folderSizing.minimumBytes, 500000000);
  assert.deepEqual(
    result.directories
      .filter((d) => d.bytes > 500000000)
      .map((d) => d.path)
      .sort(),
    [
      root,
      path.join(root, "arbitrary"),
      path.join(root, "arbitrary", "node_modules"),
      path.join(root, "arbitrary", "node_modules", "package"),
    ].sort(),
  );
  assert.equal(result.findings.length, 0);
  assert.equal(result.folderSizing.basis, "logical-file-entries");
});
test("folder totals honor exclusions and junction boundaries with explicit incomplete coverage", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "reclaim-folder-scope-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  await sized(path.join(root, "keep", "file"), 100);
  await sized(path.join(root, "exclude", "file"), 900);
  await sized(path.join(temp, "outside", "file"), 1000);
  await symlink(
    path.join(temp, "outside"),
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await scan({
    root,
    operation: "folder-sizes",
    folderMinBytes: 1,
    exclusions: ["exclude"],
  });
  assert.equal(result.totalBytes, 100);
  assert.equal(result.status, "partial");
  assert(result.skipped.some((s) => s.path.endsWith("exclude")));
  assert(result.skipped.some((s) => s.path.endsWith("linked")));
  assert.equal(result.folderSizing.scopeComplete, false);
  assert(!result.directories.some((d) => d.path.includes("outside")));
});
test("cancelled folder totals remain an explicit incomplete result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-folder-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await sized(path.join(root, "file"), 10);
  const controller = new AbortController();
  controller.abort();
  const result = await scan(
    { root, operation: "folder-sizes" },
    { signal: controller.signal },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.folderSizing.scopeComplete, false);
  assert.equal(result.files.length, 0);
});

test("folder totals count hardlinked names and ignore the former directory cap", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-folder-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await sized(path.join(root, "one"), 123);
  await link(path.join(root, "one"), path.join(root, "two"));
  await sized(path.join(root, "child", "entry"), 456);
  let result = await scan({
    root,
    operation: "folder-sizes",
    folderMinBytes: 0,
  });
  assert.equal(result.totalBytes, 702);
  assert.equal(result.fileCount, 3);
  result = await scan({ root, operation: "folder-sizes", maxDirectories: 1 });
  assert.equal(result.status, "completed");
  assert.equal(result.totalBytes, 702);
  assert(!result.notices.some((n) => /limit/i.test(n)));
});

test("quick scan skips descendants of complete cached small branches and fresh mode recounts them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-folder-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const small = path.join(root, "small"),
    deep = path.join(small, "deep");
  await sized(path.join(deep, "data"), 10);
  await sized(path.join(root, "large", "data"), 1000);
  const first = await scan({
    root,
    operation: "folder-sizes",
    folderMinBytes: 100,
    folderScanMode: "fresh",
  });
  assert(first.directories.find((d) => d.path === small).complete);
  const second = await scan(
    { root, operation: "folder-sizes", folderMinBytes: 100 },
    { folderCache: first.directories },
  );
  assert(second.folderSizing.cachedBranchCount > 0);
  assert(second.folderSizing.prunedDirectoryCount > 0);
  assert(second.folderSizing.visitedDirectoryCount < first.directoryCount);
  assert.equal(second.folderSizing.estimated, true);
  assert.equal(second.totalBytes, 1010);
  assert.equal(
    second.directories.find((d) => d.path === root).directoryCount,
    first.directoryCount,
  );
  const cancel = new AbortController();
  const interrupted = await scan(
    { root, operation: "folder-sizes", folderMinBytes: 5000 },
    {
      folderCache: first.directories,
      signal: cancel.signal,
      onProgress: () => cancel.abort(),
    },
  );
  assert.equal(interrupted.folderSizing.estimated, true);
  assert.equal(interrupted.status, "cancelled");
  assert(!second.directories.some((d) => d.path === deep));
  await sized(path.join(deep, "data"), 2000);
  const quick = await scan(
    { root, operation: "folder-sizes", folderMinBytes: 100 },
    { folderCache: first.directories },
  );
  assert.equal(quick.folderSizing.estimated, true);
  const fresh = await scan(
    {
      root,
      operation: "folder-sizes",
      folderMinBytes: 100,
      folderScanMode: "fresh",
    },
    { folderCache: first.directories },
  );
  assert.equal(fresh.totalBytes, 3000);
  assert.equal(fresh.folderSizing.cachedBranchCount, 0);
  assert.equal(fresh.folderSizing.estimated, false);
  const partial = first.directories.map((d) => ({ ...d, complete: false }));
  const conservative = await scan(
    { root, operation: "folder-sizes", folderMinBytes: 100 },
    { folderCache: partial },
  );
  assert.equal(conservative.totalBytes, 3000);
  assert.equal(conservative.folderSizing.cachedBranchCount, 0);
});

test("on-demand files inspect nested branches, paginate and honor absolute exclusions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-folder-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await sized(path.join(root, "nested", "one"), 10);
  await sized(path.join(root, "nested", "two"), 20);
  const first = await inspectFolderFiles({ root, limit: 1 });
  assert.equal(first.files.length, 1);
  assert.equal(first.nextOffset, 1);
  const next = await inspectFolderFiles({ root, offset: 1, limit: 1 });
  assert.equal(next.files.length, 1);
  assert.equal(next.nextOffset, null);
  assert.notEqual(next.files[0].path, first.files[0].path);
  await assert.rejects(
    () =>
      inspectFolderFiles({
        root,
        exclusions: [root.replaceAll("\\", "/") + "/"],
      }),
    /exclu/i,
  );
});
test("changed small-folder entries invalidate pruning and a gitfile is a worktree hint", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-folder-hints-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await sized(path.join(root, "small", "data"), 10);
  await sized(path.join(root, "large", "data"), 1000);
  const first = await scan({
    root,
    operation: "folder-sizes",
    folderMinBytes: 100,
  });
  await sized(path.join(root, "small", ".git"), 500);
  const next = await scan(
    { root, operation: "folder-sizes", folderMinBytes: 100 },
    { folderCache: first.directories },
  );
  assert.equal(next.totalBytes, 1510);
  assert.equal(
    next.directories.find((d) => d.path === path.join(root, "small"))
      .hasGitFile,
    true,
  );
});
test("an in-flight native folder scan cancels without claiming complete coverage", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "reclaim-folder-active-cancel-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await sized(path.join(root, "child", "entry"), 100);
  const controller = new AbortController();
  let progress = false;
  const result = await scan(
    { root, operation: "folder-sizes" },
    {
      signal: controller.signal,
      onProgress: () => {
        progress = true;
        controller.abort();
      },
    },
  );
  assert(progress);
  assert.equal(result.status, "cancelled");
  assert.equal(result.folderSizing.scopeComplete, false);
});
test("folder scan rejects a linked ancestor even with a regular selected leaf", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "reclaim-folder-ancestor-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await sized(path.join(temp, "outside", "leaf", "entry"), 100);
  await symlink(
    path.join(temp, "outside"),
    path.join(temp, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await scan({
    root: path.join(temp, "linked", "leaf"),
    operation: "folder-sizes",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.fileCount, 0);
  assert.equal(result.totalBytes, 0);
  assert(result.errors.length);
});
