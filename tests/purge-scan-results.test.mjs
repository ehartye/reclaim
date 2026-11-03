import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  link,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const load = () => import("../scripts/purge-scan-results.mjs");
const quiet = {
  observe: async () => ({ candidates: [], ambiguous: [] }),
  validateEvidence: async () => true,
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-purge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    receipt = path.join(root, "receipt.json");
  await mkdir(path.join(dataDir, "intelligence"), { recursive: true });
  const state = {
    settings: {
      exclusions: ["keep"],
      skipCloud: false,
      developmentRoots: [root],
      folderMinBytes: 123,
      staleDays: 90,
    },
    routines: { good: { name: "kept" }, invalid: { roots: 12 } },
    cleanups: [{ id: "audit", path: "preserved", completedAt: "2026-01-01" }],
    scans: [{ id: randomUUID(), private: "SUMMARY_SECRET" }],
    reviews: { secret: "REVIEW_SECRET" },
    unrelated: { choice: 3 },
  };
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(state));
  const names = [
    randomUUID() + ".json",
    randomUUID() + ".json",
    "intelligence/" + randomUUID() + ".json",
    "intelligence/folders-" + "a".repeat(64) + ".json",
    "intelligence/measurements.json",
    "activation-before.json",
    "ignored-folder-review.json",
    "intelligence/measurements.json.tmp",
    "intelligence/" + randomUUID() + "." + randomUUID() + ".tmp",
  ];
  for (const name of names)
    await writeFile(path.join(dataDir, name), "REPORT_PAYLOAD_SECRET");
  await writeFile(path.join(dataDir, "sentinel.txt"), "KEEP");
  await writeFile(path.join(dataDir, "server.log"), "LOG");
  const options = {
    dataDir,
    receipt,
    processAdapter: quiet,
    buildCommit: "a".repeat(40),
  };
  return { root, dataDir, receipt, state, names, options };
}
async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      for (const [name, value] of Object.entries(
        await snapshot(path.join(dir, entry.name)),
      ))
        out[entry.name + "/" + name] = value;
    else out[entry.name] = await readFile(path.join(dir, entry.name), "utf8");
  }
  return out;
}
test("inventory is metadata-only and apply preserves settings, invalid presets, audits and unrelated files", async (t) => {
  const f = await fixture(t),
    api = await load(),
    before = await snapshot(f.dataDir);
  const inventory = await api.inventory(f.options);
  assert.deepEqual(await snapshot(f.dataDir), before);
  assert.equal(inventory.targets.length, f.names.length);
  assert.equal(inventory.status, "inventory");
  const text = await readFile(f.receipt, "utf8");
  for (const secret of [
    "REPORT_PAYLOAD_SECRET",
    "SUMMARY_SECRET",
    "REVIEW_SECRET",
    "preserved",
  ])
    assert.equal(text.includes('"' + secret + '"'), false);
  const done = await api.applyPurge({
    ...f.options,
    exclusiveMaintenance: true,
  });
  assert.equal(done.status, "complete");
  const state = JSON.parse(
    await readFile(path.join(f.dataDir, "state.json"), "utf8"),
  );
  assert.deepEqual(state.scans, []);
  assert.equal("reviews" in state, false);
  const retainedSettings = { ...f.state.settings };
  delete retainedSettings.staleDays;
  assert.deepEqual(state.settings, retainedSettings);
  assert.deepEqual(state.routines, f.state.routines);
  assert.deepEqual(state.cleanups, f.state.cleanups);
  assert.deepEqual(state.unrelated, f.state.unrelated);
  assert.equal(
    await readFile(path.join(f.dataDir, "sentinel.txt"), "utf8"),
    "KEEP",
  );
  assert.equal(
    await readFile(path.join(f.dataDir, "server.log"), "utf8"),
    "LOG",
  );
  assert.equal(
    (await api.applyPurge({ ...f.options, exclusiveMaintenance: true })).status,
    "complete",
  );
});
test("receipt collisions, in-data outputs, relative paths and malformed state refuse without mutation", async (t) => {
  const f = await fixture(t),
    api = await load();
  await writeFile(f.receipt, "UNRELATED");
  await assert.rejects(api.inventory(f.options), /exist|collision/i);
  assert.equal(await readFile(f.receipt, "utf8"), "UNRELATED");
  await assert.rejects(
    api.inventory({ ...f.options, receipt: path.join(f.dataDir, "new.json") }),
    /outside/i,
  );
  await assert.rejects(
    api.inventory({ ...f.options, dataDir: "relative" }),
    /absolute/i,
  );
  await unlink(f.receipt);
  await writeFile(path.join(f.dataDir, "state.json"), "{");
  await assert.rejects(api.inventory(f.options), /state/i);
  assert.equal(await readFile(path.join(f.dataDir, "state.json"), "utf8"), "{");
});
test("changed targets, additions, state preservation changes and unrelated receipts refuse", async (t) => {
  const api = await load();
  for (const change of ["target", "addition", "state", "receipt"]) {
    const f = await fixture(t);
    await api.inventory(f.options);
    if (change === "target")
      await writeFile(path.join(f.dataDir, f.names[0]), "CHANGED");
    if (change === "addition")
      await writeFile(path.join(f.dataDir, randomUUID() + ".json"), "NEW");
    if (change === "state")
      await writeFile(
        path.join(f.dataDir, "state.json"),
        JSON.stringify({ ...f.state, cleanups: [] }),
      );
    if (change === "receipt")
      await writeFile(
        f.receipt,
        JSON.stringify({ tool: "other", dataDir: f.dataDir }),
      );
    const before = await snapshot(f.dataDir);
    await assert.rejects(
      api.applyPurge({ ...f.options, exclusiveMaintenance: true }),
    );
    assert.deepEqual(await snapshot(f.dataDir), before);
  }
});
test("exclusive maintenance, active/second writers and ambiguous processes refuse before mutation", async (t) => {
  const api = await load();
  for (const observation of [
    { candidates: [{ pid: 22, dataDir: "target" }], ambiguous: [] },
    { candidates: [{ pid: 22 }, { pid: 33 }], ambiguous: [] },
    { candidates: [], ambiguous: [{ pid: 44 }] },
  ]) {
    const f = await fixture(t);
    await api.inventory(f.options);
    const before = await snapshot(f.dataDir);
    await assert.rejects(api.applyPurge(f.options), /exclusive/i);
    await assert.rejects(
      api.applyPurge({
        ...f.options,
        exclusiveMaintenance: true,
        processAdapter: { ...quiet, observe: async () => observation },
      }),
      /writer|ambiguous|process/i,
    );
    assert.deepEqual(await snapshot(f.dataDir), before);
  }
});
test("missing targets and interrupted deletion resume without restoring data", async (t) => {
  const api = await load(),
    f = await fixture(t);
  await api.inventory(f.options);
  await unlink(path.join(f.dataDir, f.names[0]));
  let count = 0;
  const result = await api.applyPurge({
    ...f.options,
    exclusiveMaintenance: true,
    fileOps: {
      unlink: async (name) => {
        if (++count === 2) throw new Error("injected deletion failure");
        await unlink(name);
      },
    },
  });
  assert.equal(result.status, "partial");
  assert.ok(result.errors.length);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.dataDir, "state.json"), "utf8"))
      .scans,
    [],
  );
  assert.equal(
    (await api.applyPurge({ ...f.options, exclusiveMaintenance: true })).status,
    "complete",
  );
});
test("state-write interruption does not delete results and can resume", async (t) => {
  const api = await load(),
    f = await fixture(t);
  await api.inventory(f.options);
  const before = await snapshot(f.dataDir);
  const result = await api.applyPurge({
    ...f.options,
    exclusiveMaintenance: true,
    fileOps: {
      rename: async () => {
        throw new Error("injected write failure");
      },
    },
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(await snapshot(f.dataDir), before);
  assert.equal(
    (await api.applyPurge({ ...f.options, exclusiveMaintenance: true })).status,
    "complete",
  );
});
test("junction boundaries and target links are refused, unknown links disclosed and untouched", async (t) => {
  const api = await load(),
    f = await fixture(t),
    elsewhere = path.join(f.root, "elsewhere");
  await mkdir(elsewhere);
  const link = path.join(f.root, "linked");
  await symlink(f.dataDir, link, "junction");
  await assert.rejects(
    api.inventory({ ...f.options, dataDir: link }),
    /link|reparse/i,
  );
  await symlink(elsewhere, path.join(f.dataDir, "unknown-link"), "junction");
  const inv = await api.inventory(f.options);
  assert.ok(inv.unknown.some((x) => x.path === "unknown-link"));
  await unlink(path.join(f.dataDir, f.names[0]));
  await symlink(elsewhere, path.join(f.dataDir, f.names[0]), "junction");
  await assert.rejects(
    api.applyPurge({ ...f.options, exclusiveMaintenance: true }),
    /link|reparse|target/i,
  );
});
test("sealed ownership refuses forged targets, modified digest and copied receipts", async (t) => {
  const api = await load();
  for (const mode of ["target", "owner", "copied"]) {
    const f = await fixture(t);
    await api.inventory(f.options);
    const value = JSON.parse(await readFile(f.receipt, "utf8"));
    if (mode === "target") {
      value.targets[0].path = "../sentinel.txt";
      await writeFile(f.receipt, JSON.stringify(value));
    }
    if (mode === "owner") {
      value.owner = "different-owner";
      await writeFile(f.receipt, JSON.stringify(value));
    }
    if (mode === "copied") {
      const copy = f.receipt + ".copy";
      await copyFile(f.receipt, copy);
      await unlink(f.receipt);
      await copyFile(copy, f.receipt);
    }
    const before = await snapshot(f.dataDir);
    await assert.rejects(
      api.applyPurge({ ...f.options, exclusiveMaintenance: true }),
    );
    assert.deepEqual(await snapshot(f.dataDir), before);
  }
});
test("hardlinked report and receipt parent junction refuse", async (t) => {
  const f = await fixture(t),
    api = await load();
  await link(
    path.join(f.dataDir, f.names[0]),
    path.join(f.root, "outside-report"),
  );
  await assert.rejects(api.inventory(f.options), /singly-linked/i);
  await unlink(path.join(f.root, "outside-report"));
  const linkedParent = path.join(f.root, "linked-parent");
  await symlink(f.root, linkedParent, "junction");
  await assert.rejects(
    api.inventory({
      ...f.options,
      receipt: path.join(linkedParent, "receipt.json"),
    }),
    /link|reparse/i,
  );
});
test("resume accepts sanitized state after interrupted receipt update and cleans only matching sanitized temp", async (t) => {
  const api = await load(),
    f = await fixture(t),
    receipt = await api.inventory(f.options);
  const clean = { ...f.state, settings: { ...f.state.settings }, scans: [] };
  delete clean.reviews;
  delete clean.settings.staleDays;
  await writeFile(path.join(f.dataDir, "state.json"), JSON.stringify(clean));
  await writeFile(
    path.join(f.dataDir, ".purge-sanitized-" + receipt.id + ".tmp"),
    JSON.stringify(clean),
  );
  await unlink(path.join(f.dataDir, f.names[0]));
  const done = await api.applyPurge({
    ...f.options,
    exclusiveMaintenance: true,
  });
  assert.equal(done.status, "complete");
  assert.equal(
    (await readdir(f.dataDir)).some((name) =>
      name.startsWith(".purge-sanitized-"),
    ),
    false,
  );
});
test("malformed state structure refuses instead of repairing preferences", async (t) => {
  const api = await load();
  for (const value of [
    null,
    [],
    { settings: [], scans: [], cleanups: [] },
    { settings: {}, scans: {}, cleanups: [] },
    { settings: {}, scans: [], cleanups: null },
  ]) {
    const f = await fixture(t);
    await writeFile(path.join(f.dataDir, "state.json"), JSON.stringify(value));
    await assert.rejects(api.inventory(f.options), /state/i);
  }
});
test("production evidence requires verified launch configuration, idle shutdown and worker exits", async () => {
  const { validateServiceEvidence } =
    await import("../scripts/purge-processes.mjs");
  const dir = path.resolve("fixture-data"),
    checkout = path.dirname(dir),
    when = "2026-11-03T00:00:00.000Z";
  const evidence = {
    operatorControlsLaunchers: true,
    restartProhibitedUntilComplete: true,
    recordedAt: when,
    services: [
      {
        pid: 123,
        createdAt: when,
        executablePath: path.resolve("node.exe"),
        checkout,
        dataDir: dir,
        commandLine: "node server/index.mjs",
        launchEvidence: {
          source: "verified-process-inspection",
          observedAt: when,
          cwd: checkout,
          RECLAIM_DATA_DIR: dir,
        },
        idle: {
          product: "reclaim",
          job: null,
          cleanupBusy: false,
          measurementJob: null,
          routineBusy: false,
          observedAt: when,
        },
        shutdown: { authenticated: true, status: 200, at: when },
        exit: { observed: true, observedAt: when },
        workers: [
          { pid: 124, createdAt: when, exited: true, observedAt: when },
        ],
      },
    ],
  };
  assert.equal(validateServiceEvidence(evidence, dir), true);
  for (const mutate of [
    (e) => (e.services[0].idle.job = {}),
    (e) => (e.services[0].idle.routineBusy = true),
    (e) => (e.services[0].workers[0].exited = false),
    (e) => (e.services[0].launchEvidence.RECLAIM_DATA_DIR = null),
    (e) => (e.services[0].shutdown.authenticated = false),
    (e) => (e.services = []),
    (e) => (e.operatorControlsLaunchers = false),
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.equal(validateServiceEvidence(changed, dir), false);
  }
});
test("production evidence absence and observer failure refuse without a fallback", async (t) => {
  const api = await load(),
    f = await fixture(t);
  await api.inventory(f.options);
  const before = await snapshot(f.dataDir);
  await assert.rejects(
    api.applyPurge({
      dataDir: f.dataDir,
      receipt: f.receipt,
      exclusiveMaintenance: true,
    }),
    /evidence/i,
  );
  await assert.rejects(
    api.applyPurge({
      ...f.options,
      exclusiveMaintenance: true,
      processAdapter: {
        ...quiet,
        observe: async () => {
          throw new Error("inspection unavailable");
        },
      },
    }),
    /inspection unavailable/,
  );
  assert.deepEqual(await snapshot(f.dataDir), before);
  assert.equal(JSON.parse(await readFile(f.receipt, "utf8")).status, "refused");
});
test("unexpected sanitized temporary file is never removed", async (t) => {
  const api = await load(),
    f = await fixture(t),
    inventory = await api.inventory(f.options);
  const temp = path.join(
    f.dataDir,
    ".purge-sanitized-" + inventory.id + ".tmp",
  );
  await writeFile(temp, JSON.stringify({ sentinel: "UNRELATED" }));
  const before = await snapshot(f.dataDir);
  const partial = await api.applyPurge({
    ...f.options,
    exclusiveMaintenance: true,
  });
  assert.equal(partial.status, "partial");
  assert.deepEqual(await snapshot(f.dataDir), before);
});
