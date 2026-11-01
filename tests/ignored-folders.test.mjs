import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { findIgnoredFolders } from "../server/ignored-folders.mjs";
import { createCleanup } from "../server/cleanup.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-ignored-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relative, body = "data") => {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    return full;
  };
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  git("init", "-b", "main");
  const report = (entries) => ({
    id: "fixture",
    root,
    completedAt: new Date().toISOString(),
    directories: entries.map(([relative, bytes]) => ({
      path: path.join(root, relative),
      bytes,
      fileCount: 1,
    })),
    folderSizing: { estimated: true },
  });
  return { root, put, git, report };
}

test("Git rules, negation, nested/global excludes and strict size filtering drive discovery; ignored does not grant deletion", async (t) => {
  const { root, put, git, report } = await fixture(t);
  await put(
    ".gitignore",
    "dist/\nlocal-data/\n!local-data/\ntracked/\nsecret-data/\n",
  );
  await put(
    "package.json",
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  for (const relative of [
    "dist/deep/a",
    "local-data/a",
    "tracked/a",
    "secret-data/a",
    "exact/a",
    "missing/a",
    "nested/override/a",
    "local-excluded/a",
    "global-excluded/a",
  ])
    await put(relative);
  await put("nested/.gitignore", "override/\n");
  await put(".git/info/exclude", "local-excluded/\n");
  const globalExclude = await put("outside-ignore", "global-excluded/\n");
  git("config", "core.excludesFile", globalExclude);
  git("add", "-f", "tracked/a");
  const r = await findIgnoredFolders(
    report([
      ["dist", 20],
      ["dist/deep", 15],
      ["local-data", 20],
      ["tracked", 20],
      ["secret-data", 20],
      ["exact", 10],
      ["nested/override", 20],
      ["local-excluded", 20],
      ["global-excluded", 20],
      [".git", 1000],
    ]),
    10,
  );
  const rows = new Map(
    r.targets.map((d) => [
      path.relative(root, d.path).split(path.sep).join("/"),
      d,
    ]),
  );
  assert.deepEqual([...rows.keys()].sort(), [
    "dist",
    "global-excluded",
    "local-excluded",
    "nested/override",
    "secret-data",
  ]);
  assert.equal(rows.get("dist").cleanupSupported, true);
  assert.equal(rows.get("secret-data").cleanupSupported, false);
  assert.equal(rows.has("tracked"), false);
  assert.equal(rows.get("nested/override").ignore.source, "nested/.gitignore");
  assert.equal(
    rows.get("local-excluded").ignore.source.replaceAll("\\", "/"),
    ".git/info/exclude",
  );
  assert.equal(rows.get("dist").ignore.pattern, "dist/");
  assert(r.notices.some((n) => /Quick scan/.test(n)));
  assert.equal(r.coverage.complete, true);
});

test("linked Git worktrees use their own repository and preserve spaces and Unicode in ignore evidence", async (t) => {
  const { root, put, git, report } = await fixture(t);
  await put(".gitignore", "output λ dir/\n");
  await put("source.txt");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture");
  const worktree = path.join(root, "linked worktree");
  git("worktree", "add", "-b", "linked", worktree);
  const target = path.dirname(await put("linked worktree/output λ dir/bundle"));
  const result = await findIgnoredFolders(
    report([["linked worktree/output λ dir", 20]]),
    10,
  );
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].path, target);
  assert.equal(result.targets[0].repository, worktree);
  assert.equal(result.targets[0].ignore.pattern, "output λ dir/");
});

test("missing directories, junctions, protected output and inspection limits remain visible and cannot claim complete coverage", async (t) => {
  const { root, put, report } = await fixture(t);
  await put(".gitignore", "dist/\nmissing/\nlinked/\n");
  await put(
    "package.json",
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  await put("dist/bundle");
  await mkdir(path.join(root, "outside"));
  await symlink(
    path.join(root, "outside"),
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const r = await findIgnoredFolders(
    report([
      ["dist", 20],
      ["missing", 20],
      ["linked", 20],
    ]),
    0,
    { protectedReason: () => "Protected active application." },
  );
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].cleanupSupported, false);
  assert.match(r.targets[0].reason, /Protected/);
  assert.equal(r.skipped.length, 2);
  assert.equal(r.coverage.complete, false);
  const limited = await findIgnoredFolders(
    report([
      ["dist", 20],
      ["missing", 20],
    ]),
    0,
    { maxDirectories: 1 },
  );
  assert.equal(limited.coverage.complete, false);
  assert(limited.notices.some((n) => /limited/.test(n)));
});

test("Unreal Intermediate cleanup preserves inputs, rejects tracked output and invalidates previews when the project changes", async (t) => {
  const { root, put, git, report } = await fixture(t);
  await put(".gitignore", "Intermediate/\n");
  const project = JSON.stringify({
    Modules: [{ Name: "Game", Type: "Runtime" }],
    EngineAssociation: "5.8",
  });
  await put("Game.uproject", project);
  await put("Source/Game/Game.Build.cs", "// preserved source");
  await put("Content/source.uasset", "source asset");
  await put("Build/Windows/icon.ico", "build input");
  const output = path.dirname(await put("Intermediate/file.obj"));
  const r = await findIgnoredFolders(report([["Intermediate", 20]]), 10);
  assert.equal(r.targets[0].cleanupSupported, true);
  const cleanup = createCleanup();
  const preview = await cleanup.prepare(output);
  assert.match(preview.restore, /Unreal/);
  await put(
    "Game.uproject",
    JSON.stringify({ Modules: [{ Name: "Changed" }] }),
  );
  const changed = await cleanup.execute(preview.id, preview.phrase);
  assert.equal(changed.status, "failed");
  assert.equal(changed.deletedFiles, 0);
  await put("Game.uproject", project);
  git("add", "-f", "Intermediate/file.obj");
  await assert.rejects(cleanup.prepare(output), /tracked/);
  git("rm", "--cached", "Intermediate/file.obj");
  const next = await cleanup.prepare(output);
  assert.equal((await cleanup.execute(next.id, next.phrase)).status, "deleted");
  const { readFile } = await import("node:fs/promises");
  assert.equal(
    await readFile(path.join(root, "Build/Windows/icon.ico"), "utf8"),
    "build input",
  );
  assert.equal(
    await readFile(path.join(root, "Content/source.uasset"), "utf8"),
    "source asset",
  );
  await assert.rejects(cleanup.prepare(path.join(root, "Build")), /recognized/);
});
