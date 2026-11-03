import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as dev from "../server/project-discovery.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-dev-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, text = "data") => {
    const p = path.join(root, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  };
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  return { root, put, git };
}
test("development roots expand home, deduplicate and reject broad/network roots", () => {
  assert.deepEqual(
    dev.normalizeRoots(["~/repos", path.join(homedir(), "repos")]),
    [path.join(homedir(), "repos")],
  );
  assert.throws(
    () => dev.normalizeRoots([path.parse(process.cwd()).root]),
    /root/i,
  );
  assert.throws(() => dev.normalizeRoots(["relative"]), /absolute/i);
});
test("generated-folder evidence distinguishes restorable outputs from arbitrary build directories", async (t) => {
  const { root, put } = await fixture(t);
  await put(
    "app/package.json",
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  await put("app/package-lock.json", "{}");
  const output = path.dirname(await put("app/build/bundle.js"));
  const result = await dev.describeGenerated(output);
  assert.equal(result.kind, "generated");
  assert.match(result.restore, /build/);
  await put("unrelated/build/source.txt");
  assert.equal(
    await dev.describeGenerated(path.join(root, "unrelated/build")),
    null,
  );
  await put("empty/package.json", "{}");
  await put("empty/dist/handmade.txt");
  assert.equal(
    await dev.describeGenerated(path.join(root, "empty/dist")),
    null,
  );
});
test("registered linked worktree inspection detects new local files", async (t) => {
  const { root, put, git } = await fixture(t);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await put(
    "package.json",
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  await put(".gitignore", "node_modules/\ndist/\n");
  git("add", ".");
  git("commit", "-m", "initial");
  const wt = path.join(root, "fixture-worktrees", "old");
  git("worktree", "add", "-b", "old", wt);
  await put("node_modules/nested/package.json", "{}");
  await put("dist/bundle.js");
  const clean = await dev.inspectWorktree(wt);
  assert.equal(clean.eligible, true);
  await writeFile(path.join(wt, ".env"), "secret");
  const dirty = await dev.inspectWorktree(wt);
  assert.equal(dirty.eligible, false);
  assert.match(dirty.blockedReason, /untracked|ignored/i);
});
test("worktree removal blocks unique commits, ignored secrets, locks and main checkouts", async (t) => {
  const { root, put, git } = await fixture(t);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await put("source.txt");
  await put(".gitignore", ".env\n");
  git("add", ".");
  git("commit", "-m", "initial");
  const wt = path.join(root, "trees", "feature");
  git("worktree", "add", "-b", "feature", wt);
  assert.equal((await dev.inspectWorktree(root)).eligible, false);
  await writeFile(path.join(wt, ".env"), "secret");
  assert.match((await dev.inspectWorktree(wt)).blockedReason, /ignored/i);
  await rm(path.join(wt, ".env"));
  git("worktree", "lock", wt);
  assert.match((await dev.inspectWorktree(wt)).blockedReason, /locked/i);
  git("worktree", "unlock", wt);
  await writeFile(path.join(wt, "unique.txt"), "unique");
  execFileSync("git", ["-C", wt, "add", "."], { windowsHide: true });
  execFileSync("git", ["-C", wt, "commit", "-m", "unique"], {
    windowsHide: true,
  });
  assert.match(
    (await dev.inspectWorktree(wt)).blockedReason,
    /commit|preserv/i,
  );
});
test("worktree cleanup rejects Git flags that hide local edits", async (t) => {
  const { root, put, git } = await fixture(t);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await put("source.txt", "original");
  git("add", ".");
  git("commit", "-m", "initial");
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const wt = path.join(root, "trees", flag.slice(2));
    git("worktree", "add", "-b", flag.slice(2), wt);
    execFileSync("git", ["-C", wt, "update-index", flag, "source.txt"], {
      windowsHide: true,
    });
    await writeFile(path.join(wt, "source.txt"), "hidden local edits");
    const result = await dev.inspectWorktree(wt);
    assert.equal(result.eligible, false);
    assert.match(
      result.blockedReason,
      /hidden|skip-worktree|assume-unchanged/i,
    );
  }
});
