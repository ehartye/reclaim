import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  discoverRoutine,
  revalidateRoutineCandidate,
  defaultRoutineScopes,
  unionRoutineCandidates,
} from "../server/routine-discovery.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-routine-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, body = "data") => {
    const p = path.join(root, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
    return p;
  };
  await put(
    "app/package.json",
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  await put("app/dist/file.js");
  await put("app/dist/nested/file.js");
  const settings = {
    developmentRoots: [root],
    exclusions: [],
    skipCloud: true,
  };
  const report = (rows) => ({
    id: "saved",
    root,
    completedAt: "2026-01-01T00:00:00Z",
    options: { exclusions: [], skipCloud: true },
    folderSizing: { estimated: true },
    directories: rows.map(([relative, bytes, extra]) => ({
      path: path.join(root, relative),
      bytes,
      fileCount: 1,
      complete: true,
      ...extra,
    })),
  });
  const run = (options = {}) =>
    discoverRoutine({
      routineId: "generated-output",
      parameters: { minimumBytes: 10 },
      report: report([["app/dist", 20]]),
      settings,
      ...options,
    });
  return { root, put, settings, report, run };
}

test("snapshot discovery uses strict threshold, known scope, recorded provenance and fresh candidate binding", async (t) => {
  const { root, settings, run, report } = await fixture(t);
  const result = await run({
    report: report([
      ["app/dist", 20, { estimated: true }],
      ["app/dist/nested", 15],
      ["exact", 10],
    ]),
  });
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.logicalBytes, 20);
  assert.equal(candidate.estimated, true);
  assert.equal(candidate.recordedAt, "2026-01-01T00:00:00Z");
  assert.equal(candidate.mode, "in-app");
  assert.equal(candidate.cleanupSupported, true);
  const selected = await revalidateRoutineCandidate(result, candidate.id, {
    settings,
  });
  assert.equal(selected.path, path.join(root, "app/dist"));
  assert.equal(selected.kind, "generated");
  assert.equal(
    unionRoutineCandidates([
      result,
      {
        candidates: [
          { ...candidate, path: path.join(candidate.path, "nested") },
          candidate,
        ],
      },
    ]).length,
    1,
  );
  await assert.rejects(
    revalidateRoutineCandidate(
      JSON.parse(JSON.stringify(result)),
      candidate.id,
      { settings },
    ),
    /stale|unknown/,
  );
  await assert.rejects(
    revalidateRoutineCandidate(result, "submitted-path", { settings }),
    /stale|unknown/,
  );
  await assert.rejects(
    revalidateRoutineCandidate(result, candidate.id, {
      settings: { ...settings, exclusions: ["dist"] },
    }),
    /stale|unknown/,
  );
  await assert.rejects(
    revalidateRoutineCandidate(result, candidate.id, {
      settings,
      now: () => Date.now() + 400000,
    }),
    /stale|unknown/,
  );
});

test("global caches never prepare; exact configured size is used without borrowing parent totals", async (t) => {
  const { root, put, report, settings } = await fixture(t);
  await put("pip/Cache/wheel");
  await put("DerivedDataCache/Buckets/data");
  const pip = await discoverRoutine({
    routineId: "pip-cache",
    parameters: { minimumBytes: 10 },
    settings,
    report: report([["pip", 500]]),
    guideScopes: [{ path: path.join(root, "pip/Cache"), guideQualified: true }],
  });
  assert.equal(pip.candidates[0].logicalBytes, null);
  assert.equal(pip.candidates[0].mode, "review-only");
  assert.match(pip.candidates[0].reason, /parent-container/);
  const ddc = await discoverRoutine({
    routineId: "unreal-ddc",
    parameters: { minimumBytes: 10 },
    settings,
    report: report([["DerivedDataCache", 100]]),
    guideScopes: [{ path: path.join(root, "DerivedDataCache") }],
  });
  assert.equal(ddc.candidates[0].mode, "review-only");
  assert.equal(ddc.candidates[0].cleanupSupported, false);
  await assert.rejects(
    revalidateRoutineCandidate(ddc, ddc.candidates[0].id, { settings }),
    /guided caches/,
  );
  const guided = await discoverRoutine({
    routineId: "npm-cache",
    parameters: { minimumBytes: 10 },
    settings,
    report: report([["DerivedDataCache", 100]]),
    guideScopes: [
      {
        path: path.join(root, "DerivedDataCache"),
        guide: { qualified: true, mode: "guided" },
      },
    ],
  });
  assert.equal(guided.candidates[0].mode, "guided");
  assert.equal(guided.candidates[0].cleanupSupported, false);
  await assert.rejects(
    revalidateRoutineCandidate(guided, guided.candidates[0].id, { settings }),
    /guided caches/,
  );
  const defaults = defaultRoutineScopes("nuget-http-cache", {
    home: root,
    localAppData: root,
  });
  assert.equal(defaults[0].path, path.join(root, "NuGet", "v3-cache"));
});

test("protected, linked, missing and excluded scopes cannot grant cleanup and budgets stay explicit", async (t) => {
  const { root, settings, report, run } = await fixture(t);
  const blocked = await run({
    protectedReason: () => "Protected active runtime",
  });
  assert.equal(blocked.candidates[0].mode, "review-only");
  const none = await run({ settings: { ...settings, exclusions: ["dist"] } });
  assert.equal(none.candidates.length, 0);
  await mkdir(path.join(root, "outside"));
  await symlink(
    path.join(root, "outside"),
    path.join(root, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const unsafe = await discoverRoutine({
    routineId: "unreal-ddc",
    parameters: { minimumBytes: 0 },
    settings,
    report: report([
      ["link", 20],
      ["missing", 20],
    ]),
    guideScopes: [
      { path: path.join(root, "link") },
      { path: path.join(root, "missing") },
    ],
  });
  assert.equal(unsafe.candidates.length, 0);
  assert.equal(unsafe.coverage.complete, false);
  assert.equal(unsafe.coverage.errors.length, 2);
  const limited = await run({ maxDirectories: 0 });
  assert.equal(limited.coverage.complete, false);
  assert.equal(limited.candidates.length, 0);
});

test("age remains a hint and unmeasured typed discovery cannot claim threshold eligibility", async (t) => {
  const { settings, run } = await fixture(t);
  const future = Date.UTC(2100, 0, 1);
  const hinted = await run({
    parameters: { minimumBytes: 10, minimumAgeDays: 0 },
    now: () => future,
  });
  assert.equal(hinted.candidates[0].ageState, "possible-old");
  assert.equal(hinted.candidates[0].cleanupSupported, false);
  assert.match(hinted.candidates[0].reason, /age hint/);
  const unknown = await run({ report: undefined });
  assert.equal(unknown.candidates.length, 1);
  assert.equal(unknown.candidates[0].logicalBytes, null);
  assert.equal(unknown.candidates[0].cleanupSupported, false);
  await assert.rejects(
    revalidateRoutineCandidate(unknown, unknown.candidates[0].id, { settings }),
    /guided caches/,
  );
});

test("containing scopes preserve excluded descendants, including unenumerated named exclusions", async (t) => {
  const { root, put, settings, report, run } = await fixture(t);
  await put("app/dist/keep/private.txt");
  const descendant = path.join(root, "app/dist/keep");
  for (const options of [
    { settings: { ...settings, exclusions: [descendant] } },
    {
      report: {
        ...report([["app/dist", 20]]),
        options: { exclusions: [descendant] },
      },
    },
    { settings: { ...settings, exclusions: ["keep"] } },
  ]) {
    const result = await run(options);
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.cleanupSupported, false);
    assert.equal(candidate.mode, "review-only");
    assert.match(candidate.reason, /excluded path|Named exclusions/);
    await assert.rejects(
      revalidateRoutineCandidate(result, candidate.id, {
        settings: options.settings || settings,
      }),
    );
    // A later caller cannot turn an excluded ancestor into an accepted scope by
    // changing the public display fields on the original server result.
    Object.assign(candidate, {
      mode: "in-app",
      cleanupSupported: true,
      blockedReason: null,
    });
    await assert.rejects(
      revalidateRoutineCandidate(result, candidate.id, {
        settings: options.settings || settings,
      }),
      /excluded or protected/,
    );
  }
});

test("a stalled guide returns partial within budget and late resolutions cannot authorize candidates", async (t) => {
  const { root, report, settings } = await fixture(t);
  let release,
    entered = false;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const started = performance.now();
  const result = await discoverRoutine({
    routineId: "npm-cache",
    parameters: { minimumBytes: 10 },
    settings,
    report: report([["app/dist", 20]]),
    guideScopes: [{ path: path.join(root, "app/dist") }],
    budgetMs: 200,
    guideForCandidate: () => {
      entered = true;
      return late;
    },
  });
  assert.equal(entered, true);
  assert.ok(
    performance.now() - started < 2000,
    "discovery must not wait for the guide",
  );
  assert.equal(result.coverage.complete, false);
  assert.equal(result.candidates.length, 0);
  assert.match(result.coverage.errors[0].reason, /time budget.*partial/);
  release({ qualified: true, mode: "guided" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.candidates.length, 0);

  let rejectLate;
  const rejected = await discoverRoutine({
    routineId: "npm-cache",
    parameters: { minimumBytes: 10 },
    settings,
    report: report([["app/dist", 20]]),
    guideScopes: [{ path: path.join(root, "app/dist") }],
    budgetMs: 200,
    guideForCandidate: () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      }),
  });
  assert.equal(rejected.coverage.complete, false);
  rejectLate(new Error("Late guide failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected.candidates.length, 0);
});

test("settings and report exclusions are snapshotted before asynchronous discovery", async (t) => {
  const { settings, report, run } = await fixture(t);
  const selectedReport = report([["app/dist", 20]]);
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = run({
    report: selectedReport,
    guideForCandidate: () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await ready;
  settings.exclusions.push("keep");
  selectedReport.options.exclusions.push("keep");
  release(null);
  const result = await pending;
  assert.equal(
    result.candidates[0].cleanupSupported,
    true,
    "discovery uses the entry policy snapshot",
  );
  await assert.rejects(
    revalidateRoutineCandidate(result, result.candidates[0].id, { settings }),
    /stale|unknown/,
  );
  settings.exclusions.pop();
  const accepted = await revalidateRoutineCandidate(
    result,
    result.candidates[0].id,
    { settings },
  );
  assert.equal(
    accepted.kind,
    "generated",
    "caller mutations must not change the saved report exclusions",
  );
});

test("worktree discovery verifies only bounded registration before delegating full safety to preparation", async (t) => {
  const { root, put, settings, report } = await fixture(t);
  const exec = promisify(execFile);
  const main = path.join(root, "main"),
    linked = path.join(root, "linked");
  await put("main/file.txt");
  const git = (...args) =>
    exec("git", ["-C", main, ...args], { windowsHide: true, timeout: 5000 });
  await git("init");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "add",
    "file.txt",
  );
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await git("worktree", "add", "-b", "fixture-linked", linked);
  await put("linked/dirty-untracked.txt");
  const options = {
    routineId: "linked-worktrees",
    parameters: { minimumBytes: 10 },
    settings,
    report: report([["linked", 20, { hasGitFile: true }]]),
  };
  const result = await discoverRoutine(options);
  assert.equal(result.candidates[0].mode, "in-app");
  assert.match(
    result.candidates[0].reason,
    /Fresh cleanup review must still verify local changes/,
  );
  await git("worktree", "lock", linked);
  const locked = await discoverRoutine(options);
  assert.equal(locked.candidates[0].mode, "review-only");
  assert.match(locked.candidates[0].reason, /locked/);
  await put("unregistered/.git", "gitdir: missing");
  const marker = await discoverRoutine({
    ...options,
    report: report([["unregistered", 20, { hasGitFile: true }]]),
  });
  assert.equal(marker.candidates[0].mode, "review-only");
  assert.match(marker.candidates[0].reason, /registration is unavailable/);
});
