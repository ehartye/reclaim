import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  routineDefinitions,
  getRoutineDefinition,
  routineMode,
  generatedRoutineId,
  supportsRoutinePreparation,
} from "../server/routine-policies.mjs";
import {
  defaultRoutinePreset,
  validateRoutinePreset,
  loadRoutinePresets,
  saveRoutinePreset,
} from "../server/routine-presets.mjs";
import { routineSizeMatches } from "../shared/routines.ts";

test("catalog offers thirteen routine families and a permanently review-only Zen lead; global caches cannot prepare", () => {
  assert.equal(routineDefinitions.length, 14);
  assert.equal(new Set(routineDefinitions.map((r) => r.id)).size, 14);
  for (const definition of routineDefinitions) {
    assert.equal(definition.defaults.minimumBytes, 500000000);
    assert.equal(definition.defaults.minimumAgeDays, null);
    assert(definition.boundary && definition.evidence.length);
    if (definition.scope !== "project") {
      assert.notEqual(definition.mode, "in-app");
      assert.equal(
        supportsRoutinePreparation(definition.id, {
          mode: "in-app",
          kind: "generated",
          label: "JavaScript build output",
          cleanupSupported: true,
        }),
        false,
      );
      assert.equal(routineMode(definition.id), "review-only");
    }
  }
  assert.equal(
    routineMode("unreal-zen", { guideQualified: true }),
    "review-only",
  );
  assert.equal(routineMode("npm-cache", { guideQualified: true }), "guided");
  assert.equal(
    routineMode("npm-cache", { guideQualified: "true" }),
    "review-only",
  );
  assert.equal(
    routineMode("npm-cache", {
      guideQualified: true,
      blockedReason: "Active consumer",
    }),
    "review-only",
  );
  assert.throws(() => getRoutineDefinition("__proto__"), /known/);
  assert.throws(
    () => getRoutineDefinition({ id: "generated-output" }),
    /known/,
  );
});

test("existing generated policy recognition cannot turn a basename or guided scope into permission", () => {
  const candidate = {
    kind: "generated",
    label: "JavaScript build output",
    mode: "in-app",
    cleanupSupported: true,
  };
  assert.equal(generatedRoutineId(candidate), "generated-output");
  assert.equal(
    generatedRoutineId({ kind: "generated", label: "DerivedDataCache" }),
    null,
  );
  assert.equal(supportsRoutinePreparation("generated-output", candidate), true);
  for (const change of [
    { mode: "guided" },
    { cleanupSupported: false },
    { blockedReason: "Tracked files" },
    { label: "Arbitrary output" },
    { kind: "worktree" },
  ])
    assert.equal(
      supportsRoutinePreparation("generated-output", {
        ...candidate,
        ...change,
      }),
      false,
    );
  assert.equal(
    supportsRoutinePreparation("engine-imports", {
      ...candidate,
      label: "Unity Library",
    }),
    true,
  );
  assert.equal(
    supportsRoutinePreparation("linked-worktrees", {
      mode: "in-app",
      kind: "worktree",
      cleanupSupported: true,
    }),
    true,
  );
  assert.equal(
    supportsRoutinePreparation("linked-worktrees", candidate),
    false,
  );
});

test("decimal byte threshold is strict, defaults do not reuse legacy planner settings, and presets survive serialization", () => {
  assert.equal(routineSizeMatches(500000000, 500000000), false);
  assert.equal(routineSizeMatches(500000001, 500000000), true);
  for (const bytes of [null, undefined, -1, NaN, Infinity, "600000000"])
    assert.equal(routineSizeMatches(bytes, 0), false);
  const legacy = { opportunityMinBytes: 104857600, opportunityAgeDays: 30 };
  const copy = structuredClone(legacy);
  const roots = [path.join(tmpdir(), "routine-project")];
  const initial = defaultRoutinePreset("generated-output", roots);
  assert.equal(initial.minimumBytes, 500000000);
  assert.equal(initial.minimumAgeDays, null);
  const saved = saveRoutinePreset(undefined, {
    routineId: "generated-output",
    minimumBytes: 700000000,
    minimumAgeDays: 30,
    roots,
  });
  assert.deepEqual(
    loadRoutinePresets(JSON.parse(JSON.stringify(saved))),
    saved,
  );
  assert.deepEqual(legacy, copy);
  assert.equal(saved.presets["generated-output"].minimumBytes, 700000000);
});

test("preset inputs reject arbitrary commands, broad roots, unsupported age rules and stale policies", () => {
  const valid = {
    routineId: "generated-output",
    minimumBytes: 0,
    minimumAgeDays: null,
    roots: [],
  };
  for (const input of [
    null,
    [],
    { ...valid, command: "erase" },
    { ...valid, path: tmpdir() },
    { ...valid, args: [] },
    { ...valid, minimumBytes: -1 },
    { ...valid, minimumBytes: 1.5 },
    { ...valid, minimumAgeDays: -1 },
    { ...valid, minimumAgeDays: 1.5 },
    { ...valid, policyVersion: 9 },
    { ...valid, roots: [path.parse(tmpdir()).root] },
    { ...valid, roots: ["relative"] },
    { routineId: "npm-cache", roots: [tmpdir()] },
    { routineId: "npm-cache", minimumAgeDays: 30 },
  ])
    assert.throws(() => validateRoutinePreset(input));
  assert.deepEqual(validateRoutinePreset({ routineId: "npm-cache" }).roots, []);
  assert.throws(
    () => loadRoutinePresets({ schemaVersion: 2, presets: {} }),
    /Unsupported/,
  );
});

test("changed/invalid stored presets retain only correctable parameters, never become runnable, and can be replaced explicitly", () => {
  const stored = {
    schemaVersion: 1,
    presets: {
      "generated-output": {
        routineId: "generated-output",
        policyVersion: 99,
        minimumBytes: 123,
        roots: [],
        minimumAgeDays: null,
      },
      "npm-cache": {
        routineId: "npm-cache",
        minimumBytes: 4,
        roots: [],
        minimumAgeDays: null,
        command: "do not execute",
      },
    },
  };
  const result = loadRoutinePresets(stored);
  assert.deepEqual(result.presets, {});
  assert.equal(
    result.invalidPresets["generated-output"].parameters.minimumBytes,
    123,
  );
  assert.match(
    result.invalidPresets["generated-output"].error,
    /policy changed/,
  );
  assert.equal(
    Object.hasOwn(result.invalidPresets["npm-cache"].parameters, "command"),
    false,
  );
  assert.deepEqual(
    loadRoutinePresets(JSON.parse(JSON.stringify(result))),
    result,
  );
  const corrected = saveRoutinePreset(result, {
    routineId: "generated-output",
    minimumBytes: 123,
  });
  assert.equal(corrected.presets["generated-output"].minimumBytes, 123);
  assert.equal(
    Object.hasOwn(corrected.invalidPresets, "generated-output"),
    false,
  );
  assert(Object.hasOwn(corrected.invalidPresets, "npm-cache"));
  assert.equal(stored.presets["generated-output"].policyVersion, 99);
});
