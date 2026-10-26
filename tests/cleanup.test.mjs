import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createCleanup } from "../server/cleanup.mjs";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "project"),
    target = path.join(app, "node_modules");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(app, "package.json"), "{}");
  await writeFile(path.join(app, "package-lock.json"), "{}");
  await writeFile(path.join(target, "data.bin"), "package");
  const cleanup = createCleanup({
    protectedPaths: [path.join(root, "protected")],
    onRecord: async () => {},
  });
  return { root, app, target, cleanup };
}
test("cleanup requires exact typed confirmation and deletes only prepared generated data once", async (t) => {
  const { target, app, cleanup } = await fixture(t);
  const p = await cleanup.prepare(target);
  assert.equal(p.bytes, 7);
  assert.equal(p.fileCount, 1);
  assert.match(p.restore, /npm ci/);
  await assert.rejects(cleanup.execute(p.id, "wrong"), /confirmation/i);
  assert.equal(
    await readFile(path.join(target, "data.bin"), "utf8"),
    "package",
  );
  const result = await cleanup.execute(p.id, p.phrase);
  assert.equal(result.status, "deleted");
  assert.equal(result.deletedBytes, 7);
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.equal(await readFile(path.join(app, "package.json"), "utf8"), "{}");
  await assert.rejects(cleanup.execute(p.id, p.phrase), /expired|used/i);
});
test("expired previews cannot delete and junction substitution after preview stops removal", async (t) => {
  const { root, target } = await fixture(t);
  let clock = Date.now();
  const cleanup = createCleanup({ now: () => clock });
  const preview = await cleanup.prepare(target);
  clock += 300001;
  await assert.rejects(cleanup.execute(preview.id, preview.phrase), /expired/);
  assert.equal(
    await readFile(path.join(target, "data.bin"), "utf8"),
    "package",
  );
  const next = await cleanup.prepare(target),
    outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "precious"), "keep");
  await symlink(
    outside,
    path.join(target, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await cleanup.execute(next.id, next.phrase);
  assert.equal(result.status, "failed");
  assert.equal(result.deletedFiles, 0);
  assert.equal(await readFile(path.join(outside, "precious"), "utf8"), "keep");
});
test("changed files, newly added files and changed restoration evidence invalidate the preview", async (t) => {
  for (const mutation of ["file", "new", "manifest"]) {
    const { target, app, cleanup } = await fixture(t),
      p = await cleanup.prepare(target);
    await writeFile(
      mutation === "file"
        ? path.join(target, "data.bin")
        : mutation === "new"
          ? path.join(target, "new.txt")
          : path.join(app, "package-lock.json"),
      "changed",
    );
    const result = await cleanup.execute(p.id, p.phrase);
    assert.equal(result.status, "failed");
    assert.match(result.error, /changed|preview/i);
    assert.equal((await lstat(target)).isDirectory(), true);
  }
});
test("cleanup blocks arbitrary folders, protected ancestors, junction escape and tracked outputs", async (t) => {
  const { root, app, target, cleanup } = await fixture(t);
  await assert.rejects(cleanup.prepare(app), /recognized|generated/i);
  const protectedCleanup = createCleanup({ protectedPaths: [app] });
  await assert.rejects(protectedCleanup.prepare(target), /protected/i);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "precious"), "keep");
  await symlink(
    outside,
    path.join(target, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(cleanup.prepare(target), /link|junction|unsafe/i);
  assert.equal(await readFile(path.join(outside, "precious"), "utf8"), "keep");
  await rm(path.join(target, "escape"));
  const git = (...args) =>
    execFileSync("git", ["-C", app, ...args], { windowsHide: true });
  git("init", "-b", "main");
  git("add", ".");
  await assert.rejects(cleanup.prepare(target), /tracked/i);
});
test("a clean preserved linked worktree is removed through Git, retaining its branch and main checkout", async (t) => {
  const { root, app, cleanup } = await fixture(t);
  const git = (...args) =>
    execFileSync("git", ["-C", app, ...args], {
      windowsHide: true,
      encoding: "utf8",
    });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "initial");
  const wt = path.join(root, "trees", "done");
  git("worktree", "add", "-b", "done", wt);
  const p = await cleanup.prepare(wt, "worktree");
  const result = await cleanup.execute(p.id, p.phrase);
  assert.equal(result.status, "deleted");
  assert.match(git("branch", "--list", "done"), /done/);
  assert.equal((await lstat(app)).isDirectory(), true);
  assert(!git("worktree", "list").includes(wt.replaceAll("\\", "/")));
});
test(
  "Windows partial Git removal reports deleted files without claiming nothing was deleted",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, app, cleanup } = await fixture(t),
      git = (...args) =>
        execFileSync("git", ["-C", app, ...args], { windowsHide: true });
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(path.join(app, "a.txt"), "first");
    await writeFile(path.join(app, "z.txt"), "locked");
    git("add", ".");
    git("commit", "-m", "initial");
    const wt = path.join(root, "trees", "partial");
    git("worktree", "add", "-b", "partial", wt);
    const p = await cleanup.prepare(wt, "worktree");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p=[Console]::ReadLine();$s=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('locked');[Console]::ReadLine()|Out-Null;$s.Dispose()",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.write(path.join(wt, "z.txt") + "\n");
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", resolve);
    });
    try {
      const result = await cleanup.execute(p.id, p.phrase);
      assert.equal(result.status, "partial");
      assert(result.deletedFiles > 0);
      assert.match(result.error, /Git removal|removed|failed/i);
    } finally {
      child.stdin.end("\n");
      await new Promise((r) => child.once("close", r));
    }
  },
);
