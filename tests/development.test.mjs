import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as dev from "../server/development.mjs";

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
test("development discovery finds project outputs and registered linked worktrees without descending into modules", async (t) => {
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
  const inventory = await dev.discoverDevelopment([root]);
  assert(inventory.targets.some((x) => x.path === path.join(root, "dist")));
  assert(
    inventory.targets.find((x) => x.path === path.join(root, "dist"))
      .lastCommitAt,
  );
  assert(inventory.targets.some((x) => x.kind === "worktree" && x.path === wt));
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
test("targeted discovery finds deep build, modules and caches without walking their contents", async (t) => {
  const { root, put } = await fixture(t),
    project = path.join(root, "a/b/c/d/e/f/g/app");
  await put(
    "a/b/c/d/e/f/g/app/package.json",
    '{"scripts":{"build":"vite build"}}',
  );
  await put("a/b/c/d/e/f/g/app/package-lock.json", "{}");
  await put("a/b/c/d/e/f/g/app/dist/bundle.js");
  await put("a/b/c/d/e/f/g/app/node_modules/nested/fake/build/source");
  await put("a/b/c/d/e/f/g/app/.cache/nested/build/data");
  const all = await dev.discoverDevelopment([root], { operation: "all" });
  assert(
    all.targets.some(
      (x) => x.path === path.join(project, "dist") && x.category === "builds",
    ),
  );
  assert(
    all.targets.some(
      (x) =>
        x.path === path.join(project, "node_modules") &&
        x.category === "dependencies",
    ),
  );
  assert(
    all.targets.some(
      (x) =>
        x.path === path.join(project, ".cache") &&
        x.category === "caches" &&
        x.cleanupSupported === false,
    ),
  );
  assert(all.coverage.complete);
  assert(all.coverage.directoriesVisited < 15);
  assert.equal(all.coverage.skippedSubtrees, 3);
  const builds = await dev.discoverDevelopment([root], { operation: "builds" });
  assert.equal(builds.targets.length, 1);
  assert.equal(builds.targets[0].category, "builds");
  const modules = await dev.discoverDevelopment([root], {
    operation: "dependencies",
  });
  assert.equal(modules.targets.length, 1);
  const caches = await dev.discoverDevelopment([root], { operation: "caches" });
  assert.equal(caches.targets.length, 1);
});
test("directory discovery coverage and exclusions are explicit; unverified names are review-only", async (t) => {
  const { root, put } = await fixture(t);
  await put("manual/build/source.txt");
  await put("excluded/.cache/content");
  const found = await dev.discoverDevelopment([root], {
    operation: "all",
    exclusions: ["excluded"],
  });
  const unverified = found.targets.find(
    (t) => t.path === path.join(root, "manual/build"),
  );
  assert.equal(unverified.cleanupSupported, false);
  assert(!found.targets.some((t) => t.path.includes("excluded")));
  const limited = await dev.discoverDevelopment([root], {
    operation: "all",
    maxDirectories: 1,
  });
  assert.equal(limited.coverage.complete, false);
  assert(limited.notices.some((s) => /directory limit/i.test(s)));
  await assert.rejects(
    dev.discoverDevelopment([root], { operation: "unknown" }),
    /operation/i,
  );
});
test("older-worktree discovery uses commit dates without treating age as deletion eligibility", async (t) => {
  const { root, put, git } = await fixture(t);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await put("source.txt");
  git("add", ".");
  execFileSync("git", ["-C", root, "commit", "-m", "old baseline"], {
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
  const wt = path.join(root, "trees", "older");
  git("worktree", "add", "-b", "older", wt);
  await writeFile(path.join(wt, "untracked.txt"), "valuable");
  const inventory = await dev.discoverDevelopment([root], {
    operation: "stale-worktrees",
    staleDays: 90,
  });
  assert.equal(inventory.targets.length, 1);
  assert.equal(inventory.targets[0].path, wt);
  assert.match(inventory.targets[0].reason, /age.*hint/i);
  assert.equal((await dev.inspectWorktree(wt)).eligible, false);
  const excluded = await dev.discoverDevelopment([root], {
    operation: "worktrees",
    exclusions: ["trees"],
  });
  assert.equal(excluded.targets.length, 0);
});
test("a selected source container named build does not hide nested projects", async (t) => {
  const { root, put } = await fixture(t);
  await put("build/deep/project/package.json", "{}");
  await put("build/deep/project/package-lock.json", "{}");
  await put("build/deep/project/node_modules/data");
  const found = await dev.discoverDevelopment([path.join(root, "build")], {
    operation: "dependencies",
  });
  assert.equal(found.targets.length, 1);
  assert.equal(found.coverage.complete, true);
});
test("folder-type operations do not require valid Git metadata and Git errors do not hide folder leads", async (t) => {
  const { root, put } = await fixture(t);
  await put("app/.git", "gitdir: missing-target");
  await put("app/package.json", "{}");
  await put("app/package-lock.json", "{}");
  await put("app/node_modules/data");
  const deps = await dev.discoverDevelopment([root], {
    operation: "dependencies",
  });
  assert.equal(deps.targets.length, 1);
  assert.equal(deps.coverage.complete, true);
  const all = await dev.discoverDevelopment([root], { operation: "all" });
  assert(all.targets.some((t) => t.category === "dependencies"));
  assert.equal(all.coverage.complete, false);
  assert(all.notices.length > 0);
});
