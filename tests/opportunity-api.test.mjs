import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
test("productive opportunity API reuses reports, probes installation activity and measures only known targets", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-opportunity-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project"),
    modules = path.join(root, "node_modules");
  await mkdir(modules, { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(path.join(modules, ".package-lock.json"), "{}");
  await writeFile(path.join(modules, "data.bin"), Buffer.alloc(1024 ** 2, 2));
  const app = await createApp({ dataDir: path.join(dir, "state") });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    initial = await fetch(base + "/api/state").then((r) => r.json());
  const send = (url, body, headers = {}) =>
    fetch(base + "/api/" + url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": initial.token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const discovery = await send("development", {
    root,
    operation: "dependencies",
  }).then((r) => r.json());
  assert(discovery.targets[0].activity.latestAt);
  assert.equal(discovery.targets[0].activity.complete, false);
  const id = discovery.targets[0].id;
  let saved = await send("settings", {
    opportunityAgeDays: 45,
    opportunityMinBytes: 0,
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).opportunityAgeDays, 45);
  assert.equal(
    (
      await send(
        "measurements/start",
        { targetIds: [id] },
        { Origin: "https://foreign.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await send("measurements/start", { targetIds: ["unknown"] })).status,
    400,
  );
  assert.equal(
    (await send("measurements/start", { path: modules })).status,
    400,
  );
  const started = await send("measurements/start", { targetIds: [id] });
  assert.equal(started.status, 202);
  assert.equal((await send("scans", { root })).status, 409);
  assert.equal((await send("cleanup/prepare", { targetId: id })).status, 409);
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = await fetch(base + "/api/intelligence").then((r) => r.json());
    if (!snapshot.measurementJob) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(snapshot.measurementJob, null);
  const evidence = snapshot.measurements[id];
  assert.equal(evidence.status, "complete");
  assert(evidence.logicalBytes >= 1024 ** 2);
  assert(evidence.newestActivityAt > Date.now() - 60000);
  assert.equal(app.state.scans.length, 0);
  assert.equal(
    (await readFile(path.join(modules, "data.bin"))).length,
    1024 ** 2,
  );
  const preview = await send("cleanup/prepare", { targetId: id }).then((r) =>
    r.json(),
  );
  const result = await send("cleanup/execute", {
    id: preview.id,
    confirmation: preview.phrase,
  }).then((r) => r.json());
  assert.equal(result.status, "deleted");
  const after = await fetch(base + "/api/intelligence").then((r) => r.json());
  assert(
    after.changes.some(
      (c) =>
        c.path === modules && c.changedAt >= Date.parse(evidence.measuredAt),
    ),
  );
  const quick = await send("development/quick", {
    root,
    operation: "dependencies",
  }).then((r) => r.json());
  assert.equal(quick.targets.length, 0);
});
test("protected utility folders are excluded from productive cleanup support", async (t) => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "reclaim-protected-opportunities-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await createApp({ dataDir: dir });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    state = await fetch(base + "/api/state").then((r) => r.json());
  const response = await fetch(base + "/api/development", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": state.token,
    },
    body: JSON.stringify({
      root: path.resolve("."),
      operation: "dependencies",
    }),
  });
  const discovered = await response.json(),
    ownModules = discovered.targets.find(
      (t) => t.path === path.resolve("node_modules"),
    );
  assert(ownModules);
  assert.equal(ownModules.cleanupSupported, false);
  assert.match(ownModules.blockedReason, /protected/i);
});
test("quick look returns cached estimates before a current directory discovery", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-quick-look-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"scripts":{"build":"vite build"}}',
  );
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(
    path.join(root, "node_modules", "data.bin"),
    Buffer.alloc(1024 ** 2, 3),
  );
  const app = await createApp({ dataDir: path.join(dir, "state") });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    state = await fetch(base + "/api/state").then((r) => r.json());
  const send = (url, body) =>
    fetch(base + "/api/" + url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": state.token,
      },
      body: JSON.stringify(body),
    });
  await send("scans", { root, minimumBytes: 1 });
  for (let i = 0; i < 100; i++) {
    if (app.state.scans.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "new-output.bin"), "new");
  const response = await send("development/quick", { root, operation: "all" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source, "saved");
  assert.equal(result.coverage.directoriesVisited, 0);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].recorded.exclusiveLogicalBytes, 1024 ** 2);
  assert.equal(app.state.scans.length, 1);
  const full = await send("development", { root, operation: "all" }).then((r) =>
    r.json(),
  );
  assert(full.targets.some((t) => t.path === path.join(root, "dist")));
});
