import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
import { createCleanup } from "../server/cleanup.mjs";

async function fixture(t, routineProbe, routines, cleanupFactory) {
  const temp = await mkdtemp(path.join(tmpdir(), "reclaim-routines-api-"));
  const root = path.join(temp, "project"),
    dist = path.join(root, "dist"),
    cache = path.join(root, "cache", "_cacache"),
    dataDir = path.join(temp, "data");
  for (const directory of [dist, cache, dataDir])
    await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "fixture-only" } }),
  );
  await writeFile(path.join(dist, "bundle"), "data");
  await writeFile(path.join(cache, "entry"), "keep");
  const scanId = "11111111-1111-4111-8111-111111111111";
  const report = {
    id: scanId,
    root,
    completedAt: new Date().toISOString(),
    directories: [
      { path: root, bytes: 1400000000, fileCount: 2, complete: true },
      { path: dist, bytes: 600000001, fileCount: 1, complete: true },
      { path: cache, bytes: 700000000, fileCount: 1, complete: true },
    ],
    options: { operation: "folder-sizes", exclusions: [], skipCloud: true },
    folderSizing: {
      accountingVersion: 2,
      minimumBytes: 0,
      scopeComplete: true,
    },
  };
  const state = {
    settings: {
      developmentRoots: [root],
      exclusions: [],
      opportunityMinBytes: 104857600,
      opportunityAgeDays: 30,
    },
    scans: [{ id: scanId, root, completedAt: report.completedAt }],
    reviews: {},
    cleanups: [],
    ...(routines ? { routines } : {}),
  };
  await writeFile(path.join(dataDir, scanId + ".json"), JSON.stringify(report));
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(state));
  const probe =
    routineProbe ||
    (async () => ({
      scopes: [{ routineId: "npm-cache", path: cache }],
      notices: ["Fixture probe only; no installed command ran."],
    }));
  const app = await createApp({
    dataDir,
    routineProbe: probe,
    ...(cleanupFactory ? { cleanupFactory } : {}),
  });
  t.after(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await fetch(base + "/api/state").then((r) => r.json());
  const post = (route, body, token = initial.token) =>
    fetch(base + "/api/" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Reclaim-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  const run = (routineId = "generated-output", parameters) =>
    post("routines/run", {
      routineId,
      scanId,
      ...(parameters ? { parameters } : {}),
    });
  return { app, base, post, run, root, dist, cache, dataDir, scanId, state };
}

test("routine catalog reads are pure; strict presets persist while dropping retired planner settings and preserving reports", async (t) => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.dataDir, "state.json"), "utf8");
  const reportBefore = await readFile(
    path.join(f.dataDir, f.scanId + ".json"),
    "utf8",
  );
  const catalog = await fetch(f.base + "/api/routines").then((r) => r.json());
  assert.equal(catalog.definitions.length, 14);
  assert.equal(catalog.presets["generated-output"].minimumBytes, 500000000);
  assert.equal(
    await readFile(path.join(f.dataDir, "state.json"), "utf8"),
    before,
  );
  assert.equal(
    (await f.post("routines/presets", { routineId: "generated-output" }, null))
      .status,
    403,
  );
  for (const body of [
    { routineId: "unknown" },
    { routineId: "generated-output", command: "forbidden" },
    { routineId: "generated-output", minimumBytes: -1 },
    { routineId: "npm-cache", roots: [f.root] },
  ])
    assert.equal((await f.post("routines/presets", body)).status, 400);
  const saved = await f.post("routines/presets", {
    routineId: "generated-output",
    minimumBytes: 600000001,
    minimumAgeDays: null,
    roots: [f.root],
  });
  assert.equal(saved.status, 200);
  const equal = await f.run().then((r) => r.json());
  assert.equal(equal.candidates.length, 0);
  await f.app.close();
  const restarted = await createApp({ dataDir: f.dataDir });
  assert.equal(
    restarted.state.routines.presets["generated-output"].minimumBytes,
    600000001,
  );
  assert.equal(restarted.state.settings.opportunityMinBytes, undefined);
  assert.equal(restarted.state.settings.opportunityAgeDays, undefined);
  assert.equal(restarted.state.reviews, undefined);
  assert.equal(
    await readFile(path.join(f.dataDir, f.scanId + ".json"), "utf8"),
    reportBefore,
  );
  await restarted.close();
});

test("invalid persisted presets stay visible and blocked until explicitly corrected", async (t) => {
  const f = await fixture(t, undefined, {
    schemaVersion: 1,
    presets: {
      "generated-output": { routineId: "generated-output", minimumBytes: -1 },
    },
  });
  const before = await readFile(path.join(f.dataDir, "state.json"), "utf8");
  const catalog = await fetch(f.base + "/api/routines").then((r) => r.json());
  assert.ok(catalog.invalidPresets["generated-output"].error);
  assert.equal(catalog.presets["generated-output"].minimumBytes, 500000000);
  assert.equal(
    await readFile(path.join(f.dataDir, "state.json"), "utf8"),
    before,
  );
  assert.equal((await f.run()).status, 400);
  const corrected = await f.post("routines/presets", {
    routineId: "generated-output",
    minimumBytes: 500000000,
    roots: [f.root],
  });
  assert.equal(corrected.status, 200);
  assert.equal(
    (await corrected.json()).invalidPresets["generated-output"],
    undefined,
  );
  assert.equal((await f.run()).status, 200);
});

test("server-issued routine candidates use fresh existing cleanup and reject stale, foreign and guided scopes", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post("routines/run", { routineId: "unknown" })).status,
    400,
  );
  assert.equal(
    (
      await f.post("routines/run", {
        routineId: "generated-output",
        path: f.dist,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.run("generated-output", { qualification: {} })).status,
    400,
  );
  assert.equal(
    (
      await f.post("routines/run", {
        routineId: "generated-output",
        scanId: "unknown",
      })
    ).status,
    404,
  );
  const runResponse = await f.run();
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.candidates.length, 1);
  const request = { runId: run.id, candidateId: run.candidates[0].id };
  assert.equal(
    (await f.post("routines/candidates/prepare", { ...request, path: f.cache }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.post("routines/candidates/prepare", {
        ...request,
        candidateId: "foreign",
      })
    ).status,
    409,
  );
  const previewResponse = await f.post("routines/candidates/prepare", request);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.bytes, 4);
  assert.match(preview.restore, /build/);
  assert.equal(
    (await f.post("cleanup/execute", { id: preview.id, confirmation: "wrong" }))
      .status,
    409,
  );
  assert.equal(await readFile(path.join(f.dist, "bundle"), "utf8"), "data");
  const guided = await f.run("npm-cache").then((r) => r.json());
  assert.equal(guided.candidates.length, 1);
  assert.equal(guided.candidates[0].mode, "review-only");
  assert.equal(guided.candidates[0].guide.commands.length, 0);
  assert.equal(
    (
      await f.post("routines/candidates/prepare", {
        runId: guided.id,
        candidateId: guided.candidates[0].id,
      })
    ).status,
    409,
  );
  await f.post("routines/presets", {
    routineId: "generated-output",
    minimumBytes: 0,
  });
  assert.equal(
    (await f.post("routines/candidates/prepare", request)).status,
    409,
  );
  const current = await f.run().then((r) => r.json());
  await f.post("settings", { exclusions: [f.dist] });
  assert.equal(
    (
      await f.post("routines/candidates/prepare", {
        runId: current.id,
        candidateId: current.candidates[0].id,
      })
    ).status,
    409,
  );
  assert.equal((await f.run().then((r) => r.json())).candidates.length, 0);
  assert.equal(f.app.state.cleanups.length, 0);
  assert.equal(await readFile(path.join(f.cache, "entry"), "utf8"), "keep");
});

test("routine evidence expires and successful fixture deletion still uses the legacy executor receipt", async (t) => {
  const f = await fixture(t);
  const run = await f.run().then((r) => r.json());
  const request = { runId: run.id, candidateId: run.candidates[0].id };
  const original = Date.now;
  Date.now = () => original() + 300001;
  try {
    assert.equal(
      (await f.post("routines/candidates/prepare", request)).status,
      409,
    );
  } finally {
    Date.now = original;
  }
  const fresh = await f.run().then((r) => r.json());
  const preview = await f
    .post("routines/candidates/prepare", {
      runId: fresh.id,
      candidateId: fresh.candidates[0].id,
    })
    .then((r) => r.json());
  const deleted = await f
    .post("cleanup/execute", { id: preview.id, confirmation: preview.phrase })
    .then((r) => r.json());
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.deletedBytes, 4);
  assert.equal(f.app.state.cleanups.length, 1);
  assert.equal(await readFile(path.join(f.cache, "entry"), "utf8"), "keep");
});

test("fresh routine candidates propagate cleanup inspection limits without preview or execution fallback", async (t) => {
  const prepareCalls = [];
  let executeCalls = 0;
  let failure = "Safety inspection limit reached. Choose a smaller folder.";
  const f = await fixture(t, undefined, undefined, (options) => {
    const actual = createCleanup(options);
    return {
      ...actual,
      async prepare(...args) {
        prepareCalls.push(args);
        throw new Error(failure);
      },
      async execute(...args) {
        executeCalls++;
        return actual.execute(...args);
      },
    };
  });
  const run = await f.run().then((r) => r.json());
  const request = { runId: run.id, candidateId: run.candidates[0].id };
  for (const extra of [
    { cleanupFactory: "client-seam" },
    { proof: {} },
    { prepare: {} },
  ]) {
    assert.equal(
      (await f.post("routines/candidates/prepare", { ...request, ...extra }))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await f.post("routines/run", {
        routineId: "generated-output",
        cleanupFactory: "client-seam",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.post("routines/candidates/prepare", {
        ...request,
        candidateId: "foreign",
      })
    ).status,
    409,
  );
  assert.equal(prepareCalls.length, 0);
  // A once-valid server candidate whose current exclusions changed fails before
  // the trusted cleanup seam, rather than relying on the seam to reject it.
  f.app.state.settings.exclusions.push(f.dist);
  assert.equal(
    (await f.post("routines/candidates/prepare", request)).status,
    409,
  );
  assert.equal(prepareCalls.length, 0);
  f.app.state.settings.exclusions.pop();
  for (const message of [
    "Safety inspection limit reached. Choose a smaller folder.",
    "Safety inspection timed out. Narrow the target.",
  ]) {
    failure = message;
    const response = await f.post("routines/candidates/prepare", request);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: message,
      code: "INTERNAL_ERROR",
    });
    assert.equal(prepareCalls.at(-1)[0], f.dist);
    assert.equal(prepareCalls.at(-1)[1], "generated");
    assert.deepEqual(prepareCalls.at(-1)[2], { scanId: f.scanId });
    assert.equal(
      (await fetch(f.base + "/api/state").then((r) => r.json())).cleanupBusy,
      false,
    );
    assert.equal(f.app.state.cleanups.length, 0);
    assert.equal(executeCalls, 0);
    assert.equal(await readFile(path.join(f.dist, "bundle"), "utf8"), "data");
    assert.equal(await readFile(path.join(f.cache, "entry"), "utf8"), "keep");
  }
  assert.equal(prepareCalls.length, 2);
  assert.equal((await f.run()).status, 200);
});

test("routine discovery holds global busy gates, detects settings changes and service close waits for probes", async (t) => {
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pendingProbe = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async () => {
    entered();
    return pendingProbe;
  });
  const pending = f.run("npm-cache");
  await started;
  const current = await fetch(f.base + "/api/state").then((r) => r.json());
  assert.equal(current.cleanupBusy, true);
  assert.equal((await f.post("settings", { exclusions: [] })).status, 409);
  assert.equal(
    (await f.post("scans", { root: f.root, operation: "folder-sizes" })).status,
    409,
  );
  assert.equal((await f.post("shutdown", {})).status, 409);
  assert.equal(
    (await f.post("routines/presets", { routineId: "generated-output" }))
      .status,
    409,
  );
  f.app.state.settings.exclusions.push(f.cache);
  release({ scopes: [], notices: [] });
  assert.equal((await pending).status, 409);
  assert.equal(
    (await fetch(f.base + "/api/state").then((r) => r.json())).cleanupBusy,
    false,
  );
  let releaseAgain, enteredAgain;
  const nextStarted = new Promise((resolve) => {
    enteredAgain = resolve;
  });
  const second = await fixture(t, async () => {
    enteredAgain();
    return new Promise((resolve) => {
      releaseAgain = resolve;
    });
  });
  const run = second.run("npm-cache");
  await nextStarted;
  let closed = false;
  const close = second.app.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  releaseAgain({ scopes: [], notices: [] });
  assert.equal((await run).status, 409);
  await close;
  assert.equal(closed, true);
});
