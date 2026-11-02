import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routineDefinitions } from "../server/routine-policies.mjs";
import { validateRoutinePreset } from "../server/routine-presets.mjs";
import { getRoutineGuide } from "../server/routine-guides.mjs";
import {
  discoverRoutine,
  revalidateRoutineCandidate,
} from "../server/routine-discovery.mjs";

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "reclaim-cache-acceptance-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project");
  const cache = path.join(directory, "DerivedDataCache");
  const output = path.join(root, "dist");
  const outside = path.join(directory, "outside", "dist");
  for (const folder of [cache, output, outside])
    await mkdir(folder, { recursive: true });
  for (const folder of [root, path.dirname(outside)])
    await writeFile(
      path.join(folder, "package.json"),
      JSON.stringify({ scripts: { build: "fixture-only" } }),
    );
  for (const folder of [cache, output, outside])
    await writeFile(path.join(folder, "sentinel"), "preserve");
  const settings = {
    developmentRoots: [root],
    exclusions: [],
    skipCloud: true,
  };
  const report = {
    id: "cache-acceptance-fixture",
    root: directory,
    completedAt: "2026-10-01T00:00:00Z",
    options: { exclusions: [], skipCloud: true },
    directories: [cache, output, outside].map((target) => ({
      path: target,
      bytes: 600000001,
      fileCount: 1,
      complete: true,
    })),
  };
  return { directory, root, cache, output, outside, settings, report };
}

test("AC2: every global cache stays outside preparation even with a qualified server guide", async (t) => {
  const f = await fixture(t);
  const globals = routineDefinitions.filter(
    (definition) => definition.scope !== "project",
  );
  assert.ok(globals.length > 0);
  for (const definition of globals) {
    // Give discovery the strongest trusted guide result. This must never turn
    // a global cache family into an existing generated-folder cleanup policy.
    const run = await discoverRoutine({
      routineId: definition.id,
      parameters: { minimumBytes: 500000000 },
      settings: f.settings,
      report: f.report,
      guideScopes: [
        { path: f.cache, guide: { qualified: true, mode: "guided" } },
      ],
    });
    assert.equal(run.candidates.length, 1, definition.id);
    const candidate = run.candidates[0];
    assert.equal(
      candidate.mode,
      definition.id === "unreal-zen" ? "review-only" : "guided",
      definition.id,
    );
    assert.equal(candidate.cleanupSupported, false, definition.id);
    await assert.rejects(
      revalidateRoutineCandidate(run, candidate.id, { settings: f.settings }),
      /guided caches/,
      definition.id,
    );
  }
  assert.equal(
    await readFile(path.join(f.cache, "sentinel"), "utf8"),
    "preserve",
  );
});

test("AC2: local filesystem DDC is guide-only; unknown, mixed, active and shared roles stay review-only", async (t) => {
  const f = await fixture(t);
  const qualifiedLocal = {
    source: "installed-owner",
    pathChecked: true,
    documentationVersionMatches: true,
    activity: "idle",
    version: "5.8.0",
    resolvedPath: f.cache,
    role: "filesystem-ddc",
    configurationComplete: true,
    layoutRecognized: true,
    mixedStore: false,
    foreignData: false,
    customLocation: false,
  };
  const cases = [
    ["qualified local", qualifiedLocal, "guided"],
    ["unknown role", { ...qualifiedLocal, role: "unknown" }, "review-only"],
    [
      "mixed Zen/cooked store",
      { ...qualifiedLocal, mixedStore: true },
      "review-only",
    ],
    [
      "active consumer",
      { ...qualifiedLocal, activity: "active" },
      "review-only",
    ],
    [
      "unknown activity",
      { ...qualifiedLocal, activity: "unknown" },
      "review-only",
    ],
    ["shared role", { ...qualifiedLocal, role: "shared-ddc" }, "review-only"],
    [
      "incomplete configuration",
      { ...qualifiedLocal, configurationComplete: false },
      "review-only",
    ],
    [
      "unrecognized layout",
      { ...qualifiedLocal, layoutRecognized: false },
      "review-only",
    ],
    ["foreign data", { ...qualifiedLocal, foreignData: true }, "review-only"],
    [
      "custom override",
      { ...qualifiedLocal, customLocation: true },
      "review-only",
    ],
    [
      "wrong configured path",
      { ...qualifiedLocal, resolvedPath: f.outside },
      "review-only",
    ],
    ["no owner evidence", undefined, "review-only"],
  ];
  for (const [label, qualification, expectedMode] of cases) {
    const run = await discoverRoutine({
      routineId: "unreal-ddc",
      parameters: { minimumBytes: 500000000 },
      settings: f.settings,
      report: f.report,
      guideScopes: [{ path: f.cache, qualification }],
      guideForCandidate: (routineId, target, scope) =>
        getRoutineGuide(routineId, {
          path: target,
          qualification: scope.qualification,
        }),
    });
    assert.equal(run.candidates.length, 1, label);
    const candidate = run.candidates[0];
    assert.equal(candidate.mode, expectedMode, label);
    assert.equal(candidate.guide.qualified, expectedMode === "guided", label);
    assert.deepEqual(candidate.guide.commands, [], label);
    assert.equal(candidate.cleanupSupported, false, label);
    await assert.rejects(
      revalidateRoutineCandidate(run, candidate.id, { settings: f.settings }),
      /guided caches/,
      label,
    );
  }
  // Pure guide checks only: never discover or access the network path.
  const networkScope = "\\\\fixture-server\\shared-ddc";
  for (const [target, qualification] of [
    [networkScope, { ...qualifiedLocal, resolvedPath: networkScope }],
    [f.cache, { ...qualifiedLocal, version: "5.7.0" }],
  ]) {
    const guide = getRoutineGuide("unreal-ddc", { path: target, qualification });
    assert.equal(guide.mode, "review-only");
    assert.equal(guide.qualified, false);
    assert.deepEqual(guide.commands, []);
  }
  const zen = getRoutineGuide("unreal-zen", {
    path: f.cache,
    qualification: qualifiedLocal,
  });
  assert.equal(zen.mode, "review-only");
  assert.equal(zen.qualified, false);
  assert.deepEqual(zen.commands, []);
});

test("AC2: arbitrary submitted paths and copied candidate evidence cannot authorize preparation", async (t) => {
  const f = await fixture(t);
  const run = await discoverRoutine({
    routineId: "generated-output",
    parameters: { minimumBytes: 500000000 },
    report: f.report,
    settings: f.settings,
  });
  assert.deepEqual(
    run.candidates.map((candidate) => candidate.path),
    [f.output],
  );
  const candidate = run.candidates[0];
  const selected = await revalidateRoutineCandidate(run, candidate.id, {
    settings: f.settings,
  });
  assert.equal(selected.path, f.output);
  await assert.rejects(
    revalidateRoutineCandidate(run, f.outside, { settings: f.settings }),
    /stale|unknown/,
  );
  const submitted = structuredClone(run);
  submitted.candidates[0].path = f.outside;
  submitted.candidates[0].mode = "in-app";
  submitted.candidates[0].cleanupSupported = true;
  await assert.rejects(
    revalidateRoutineCandidate(submitted, candidate.id, {
      settings: f.settings,
    }),
    /stale|unknown/,
  );
  for (const input of [
    { routineId: "unreal-ddc", path: f.outside },
    { routineId: "unreal-ddc", roots: [f.outside] },
    { routineId: "unreal-ddc", command: "arbitrary" },
  ])
    assert.throws(() => validateRoutinePreset(input));
  for (const folder of [f.output, f.outside, f.cache])
    assert.equal(
      await readFile(path.join(folder, "sentinel"), "utf8"),
      "preserve",
    );
});
