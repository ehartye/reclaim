import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RoutineBatch,
  summarizeRoutineRun,
  preparationDeadline,
  isPreparationFresh,
  sortedRoutineRows,
  routineBatchProgress,
} from "../shared/routine-batch.ts";

const START = Date.parse("2026-11-01T10:00:00.000Z");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function catalog(ids = ["a", "b", "c"]) {
  return {
    definitions: ids.map((id) => ({
      id,
      label: `Routine ${id}`,
      policyVersion: 1,
      mode: "in-app",
      scope: "project",
      recoveryCost: "low",
      description: "Fixture",
      boundary: "Review only",
      evidence: [],
      requiresGuideQualification: false,
      supportsAgeHint: true,
      defaults: { minimumBytes: 500000000, minimumAgeDays: null },
    })),
    presets: Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          routineId: id,
          policyVersion: 1,
          minimumBytes: index + 123,
          minimumAgeDays: index + 2,
          roots: [`C:/fixture/${id}`],
        },
      ]),
    ),
    invalidPresets: {},
  };
}
function run(id, candidates = [], checkedAt = new Date(START).toISOString()) {
  return {
    id: `run-${id}`,
    routineId: id,
    policyVersion: 1,
    parameters: catalog([id]).presets[id],
    checkedAt,
    candidates,
    coverage: {
      complete: true,
      candidateCount: candidates.length,
      checkedDirectories: candidates.length,
      errors: [],
    },
    notices: [],
  };
}
function candidate(path, logicalBytes, extra = {}) {
  return {
    id: path,
    path,
    mode: "in-app",
    cleanupSupported: true,
    reason: "Fixture",
    logicalBytes,
    estimated: false,
    complete: true,
    recordedAt: "2026-10-31T12:00:00.000Z",
    ...extra,
  };
}

test("fresh cloned snapshot, one concurrent request, explicit captured fields and catalog-order attempts", async () => {
  const initial = catalog(["old"]),
    fresh = catalog();
  const refreshed = deferred(),
    pending = [],
    calls = [],
    events = [];
  let active = 0,
    maximum = 0;
  const batch = new RoutineBatch({
    catalog: initial,
    scanId: "report-1",
    now: () => START,
    onChange: (state) => events.push(state),
    request: async (body) => {
      calls.push(body);
      active++;
      maximum = Math.max(maximum, active);
      const response = deferred();
      pending.push(response);
      try {
        return await response.promise;
      } finally {
        active--;
      }
    },
  });
  const completion = batch.start(() => refreshed.promise);
  assert.equal(batch.getState().status, "refreshing");
  assert.equal(
    await batch.start(async () => {
      throw Error("duplicate refresh");
    }),
    false,
  );
  assert.equal(calls.length, 0);
  refreshed.resolve(fresh);
  await tick();
  assert.deepEqual(
    batch.getState().rows.map((row) => row.definition.id),
    ["a", "b", "c"],
  );
  assert.equal(calls.length, 1);
  fresh.definitions.reverse();
  fresh.presets.b.minimumBytes = 999;
  fresh.presets.b.roots.push("C:/changed");
  const exposed = batch.getState();
  exposed.catalog.presets.b.minimumAgeDays = 999;
  for (const id of ["a", "b", "c"]) {
    pending.at(-1).resolve(run(id));
    await tick();
  }
  assert.equal(await completion, true);
  assert.equal(maximum, 1);
  assert.deepEqual(
    calls.map((body) => body.routineId),
    ["a", "b", "c"],
  );
  assert.deepEqual(calls[1], {
    routineId: "b",
    scanId: "report-1",
    parameters: {
      minimumBytes: 124,
      minimumAgeDays: 3,
      policyVersion: 1,
      roots: ["C:/fixture/b"],
    },
  });
  assert.equal(batch.getState().status, "settled");
  assert(
    events.some(
      (state) => state.rows.length === 3 && state.rows[1].status === "queued",
    ),
  );
});

test("invalid presets skip fallback requests, individual failure stays visible and later discovery continues", async () => {
  const data = catalog(["a", "b", "c", "d"]),
    calls = [];
  data.invalidPresets.b = {
    parameters: { policyVersion: 99 },
    error: "Policy changed",
  };
  const batch = new RoutineBatch({
    catalog: data,
    request: async ({ routineId }) => {
      calls.push(routineId);
      if (routineId === "a") throw Error("Server busy");
      const result = run(routineId);
      if (routineId === "c") result.coverage.complete = false;
      return result;
    },
  });
  assert.equal(await batch.start(async () => data), true);
  const state = batch.getState();
  assert.deepEqual(calls, ["a", "c", "d"]);
  assert.deepEqual(
    state.rows.map((row) => row.status),
    ["failed", "needs-settings", "partial", "successful"],
  );
  assert.equal(state.rows[0].summary, undefined);
  assert.match(state.rows[0].error, /Server busy/);
  assert.match(state.rows[1].error, /Policy changed/);
  assert.deepEqual(routineBatchProgress(state), {
    total: 4,
    checked: 2,
    failed: 1,
    needsSettings: 1,
    processed: 4,
    remaining: 0,
    notRun: 0,
    runningId: undefined,
  });
});

test("stop waits for the current response, retains it and marks unstarted rows not run", async () => {
  const data = catalog(),
    response = deferred(),
    calls = [];
  const batch = new RoutineBatch({
    catalog: data,
    request: (body) => {
      calls.push(body);
      return response.promise;
    },
  });
  const completion = batch.start(async () => data);
  await tick();
  batch.stopAfterCurrent();
  assert.equal(batch.getState().status, "stopping");
  assert.equal(batch.clearResult("a"), false);
  assert.equal(await batch.start(async () => data), false);
  response.resolve(run("a"));
  await completion;
  const state = batch.getState();
  assert.equal(calls.length, 1);
  assert.deepEqual(
    state.rows.map((row) => row.status),
    ["successful", "not-run", "not-run"],
  );
  assert.equal(state.rows[0].run.id, "run-a");
  assert.equal(routineBatchProgress(state).processed, 1);
  assert.equal(routineBatchProgress(state).notRun, 2);
});

test("stop during catalog refresh schedules no request; refresh failures retain dated results separately", async () => {
  const data = catalog(),
    response = deferred();
  let requests = 0;
  const batch = new RoutineBatch({
    catalog: data,
    scanId: "report",
    now: () => START,
    request: async () => {
      requests++;
      return run("a");
    },
  });
  batch.replaceResult(run("a"));
  const previous = batch.getState().rows[0];
  assert.equal(
    await batch.start(async () => {
      throw Error("Catalog unavailable");
    }),
    false,
  );
  assert.equal(batch.getState().refreshError, "Catalog unavailable");
  assert.deepEqual(batch.getState().rows[0], previous);
  const completion = batch.start(() => response.promise);
  batch.stopAfterCurrent();
  response.resolve(data);
  await completion;
  assert.equal(requests, 0);
  assert(batch.getState().rows.every((row) => row.status === "not-run"));
});

test("dispose suppresses late callbacks and scheduling during refresh or an in-flight request", async () => {
  for (const duringRefresh of [true, false]) {
    const data = catalog(),
      response = deferred(),
      events = [],
      calls = [];
    const batch = new RoutineBatch({
      catalog: data,
      onChange: (state) => events.push(state),
      request: (body) => {
        calls.push(body);
        return response.promise;
      },
    });
    const refreshed = deferred();
    const completion = batch.start(() =>
      duringRefresh ? refreshed.promise : Promise.resolve(data),
    );
    await tick();
    batch.dispose();
    const count = events.length;
    if (duringRefresh) refreshed.resolve(data);
    else response.resolve(run("a"));
    assert.equal(await completion, false);
    assert.equal(events.length, count);
    assert.equal(calls.length, duringRefresh ? 0 : 1);
    assert.equal(await batch.start(async () => data), false);
  }
});

test("report context changes clear results, suppress obsolete responses and prevent overlapping generations", async () => {
  const data = catalog(),
    response = deferred(),
    calls = [];
  const batch = new RoutineBatch({
    catalog: data,
    scanId: "one",
    request: (body) => {
      calls.push(body);
      return response.promise;
    },
  });
  const completion = batch.start(async () => data);
  await tick();
  batch.setContext("two");
  assert.equal(batch.getState().scanId, "two");
  assert(batch.getState().rows.every((row) => !row.run));
  assert.equal(await batch.start(async () => data), false);
  response.resolve(run("a"));
  assert.equal(await completion, false);
  assert.equal(calls.length, 1);
  assert(batch.getState().rows.every((row) => !row.run));
});

test("summaries keep logical scope, uncertainty, estimates, dates and discovery coverage without an overall total", () => {
  const known = candidate("C:/project/output", 100),
    unknown = candidate("C:/other", null);
  const mixed = run("a", [
    known,
    unknown,
    candidate("C:/project/output/child", 90),
  ]);
  const summary = summarizeRoutineRun(mixed, true);
  assert.equal(summary.candidateCount, 3);
  assert.equal(summary.scopeCount, 2);
  assert.equal(summary.knownBytes, 100);
  assert.equal(summary.unknownSizeCount, 1);
  assert.deepEqual(summary.recordedAt, [known.recordedAt]);
  assert.equal(summary.checkedAt, mixed.checkedAt);
  assert.deepEqual(summary.coverage, mixed.coverage);
  assert.equal(summarizeRoutineRun(run("a", [unknown]), true).knownBytes, null);
  const empty = summarizeRoutineRun(run("a"), true);
  assert.equal(empty.knownBytes, null);
  assert.equal(empty.candidateCount, 0);
  const noReport = summarizeRoutineRun(mixed, false);
  assert.equal(noReport.knownBytes, null);
  assert.equal(noReport.unknownSizeCount, 2);
  assert.deepEqual(noReport.recordedAt, []);
  const estimated = summarizeRoutineRun(
    run("a", [
      candidate("C:/cache", 999, { estimated: true, complete: false }),
    ]),
    true,
  );
  assert.equal(estimated.knownBytes, 999);
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.incomplete, true);
  const parentUnknown = summarizeRoutineRun(
    run("a", [
      candidate("C:\\Cache\\", null),
      candidate("c:/cache/nested", 800),
      candidate("C:/CACHE", 1200),
    ]),
    true,
  );
  assert.equal(parentUnknown.knownBytes, null);
  assert.equal(parentUnknown.scopeCount, 1);
  assert.equal(parentUnknown.unknownSizeCount, 1);
  const rows = [
    { definition: { id: "unknown" } },
    { definition: { id: "small" }, summary: { knownBytes: 2 } },
    { definition: { id: "large" }, summary: { knownBytes: 3 } },
    { definition: { id: "failed" }, status: "failed" },
  ];
  assert.deepEqual(
    sortedRoutineRows(rows).map((row) => row.definition.id),
    ["large", "small", "unknown", "failed"],
  );
  assert.equal(Object.hasOwn(summary, "total"), false);
});

test("each run owns its original deadline through a long batch, selection, reruns and preset invalidation", async () => {
  const data = catalog(["a", "b"]),
    responses = [],
    now = { value: START };
  const batch = new RoutineBatch({
    catalog: data,
    scanId: "report",
    now: () => now.value,
    request: () => {
      const response = deferred();
      responses.push(response);
      return response.promise;
    },
  });
  const completion = batch.start(async () => data);
  await tick();
  responses[0].resolve(run("a", [candidate("C:/a", 10)]));
  await tick();
  now.value += 6 * 60 * 1000;
  responses[1].resolve(
    run("b", [candidate("C:/b", 20)], new Date(now.value).toISOString()),
  );
  await completion;
  let state = batch.getState();
  assert.equal(isPreparationFresh(state.rows[0], now.value), false);
  assert.equal(isPreparationFresh(state.rows[1], now.value), true);
  assert.equal(state.rows[0].preparationDeadline, START + 300000);
  // Reading/sorting retained details cannot renew evidence.
  sortedRoutineRows(state.rows);
  state = batch.getState();
  assert.equal(state.rows[0].preparationDeadline, START + 300000);
  const b = structuredClone(state.rows[1]);
  batch.replaceResult(run("a", [], new Date(now.value).toISOString()));
  state = batch.getState();
  assert.equal(isPreparationFresh(state.rows[0], now.value), true);
  assert.deepEqual(state.rows[1], b);
  const saved = structuredClone(data);
  saved.presets.a.minimumBytes = 700;
  batch.replaceCatalog(saved);
  batch.clearResult("a");
  state = batch.getState();
  assert.equal(state.rows[0].run, undefined);
  assert.equal(state.rows[0].preset.minimumBytes, 700);
  assert.deepEqual(state.rows[1], b);
  batch.failResult("a", Error("Rerun failed"));
  assert.equal(batch.getState().rows[0].status, "failed");
  assert.equal(batch.getState().rows[0].summary, undefined);
});

test("malformed timestamps disable preparation, future clocks clamp to receipt, old evidence cannot renew", () => {
  for (const malformed of [
    "",
    "invalid",
    "123",
    "2026-11-01",
    "2026-99-99T10:00:00Z",
    "2026-02-30T10:00:00Z",
    "2026-11-01T24:00:00Z",
  ])
    assert.equal(preparationDeadline(malformed, START), null);
  assert.equal(
    preparationDeadline(new Date(START + 600000).toISOString(), START),
    START + 300000,
  );
  assert.equal(
    preparationDeadline(new Date(START - 600000).toISOString(), START),
    START - 300000,
  );
  assert.equal(
    isPreparationFresh({ run: run("a"), preparationDeadline: null }, START),
    false,
  );
  assert.equal(
    isPreparationFresh({ run: run("a"), preparationDeadline: START }, START),
    false,
  );
});

test("a new generation resets old results before requests and keeps only one latest result per routine", async () => {
  const data = catalog(["a", "b"]),
    response = deferred();
  const batch = new RoutineBatch({
    catalog: data,
    request: () => response.promise,
  });
  batch.replaceResult(run("a"));
  batch.replaceResult({ ...run("a"), id: "replacement" });
  assert.equal(batch.getState().rows.length, 2);
  assert.equal(batch.getState().rows[0].run.id, "replacement");
  const completion = batch.start(async () => data);
  await tick();
  assert(batch.getState().rows.every((row) => !row.run));
  batch.stopAfterCurrent();
  response.resolve(run("a"));
  await completion;
  assert.equal(batch.getState().rows[1].status, "not-run");
});
