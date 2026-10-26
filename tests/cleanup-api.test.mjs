import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
test("configured development roots, known targets and confirmed deletion persist through HTTP and restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-cleanup-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "projects"),
    project = path.join(root, "app"),
    target = path.join(project, "dist"),
    dataDir = path.join(dir, "data");
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(target, "bundle.js"), "built");
  let app = await createApp({ dataDir });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    state = await fetch(base + "/api/state").then((r) => r.json());
  assert.equal(state.cleanupBusy, false);
  const send = (url, body, headers = {}) =>
    fetch(base + "/api/" + url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": state.token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  let r = await send("settings", { developmentRoots: [root] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).developmentRoots, [root]);
  assert.equal(
    (await send("settings", { developmentRoots: ["relative"] })).status,
    400,
  );
  const inventory = await fetch(base + "/api/development").then((r) =>
    r.json(),
  );
  assert(inventory.targets.some((t) => t.path === target));
  assert.equal((await send("cleanup/prepare", { path: target })).status, 400);
  assert.equal(
    (
      await send(
        "cleanup/prepare",
        { targetId: inventory.targets[0].id },
        { Origin: "https://foreign.invalid" },
      )
    ).status,
    403,
  );
  r = await send("cleanup/prepare", {
    targetId: inventory.targets.find((t) => t.path === target).id,
  });
  assert.equal(r.status, 200);
  const preview = await r.json();
  assert.equal(
    (await send("cleanup/execute", { id: preview.id, confirmation: "wrong" }))
      .status,
    409,
  );
  assert.equal(await readFile(path.join(target, "bundle.js"), "utf8"), "built");
  r = await send("cleanup/execute", {
    id: preview.id,
    confirmation: preview.phrase,
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "deleted");
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.equal(
    (
      await send("cleanup/execute", {
        id: preview.id,
        confirmation: preview.phrase,
      })
    ).status,
    409,
  );
  await app.close();
  app = await createApp({ dataDir });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const next = await fetch(
    `http://127.0.0.1:${app.server.address().port}/api/state`,
  ).then((r) => r.json());
  assert.deepEqual(next.settings.developmentRoots, [root]);
  assert.equal(next.cleanups[0].status, "deleted");
  assert.equal(next.cleanups[0].deletedBytes, 5);
});
test(
  "active inspection blocks scan, settings and shutdown; service close waits for completion",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "reclaim-cleanup-close-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const project = path.join(dir, "project"),
      target = path.join(project, "dist");
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(project, "package.json"),
      '{"scripts":{"build":"vite build"}}',
    );
    await writeFile(path.join(target, "bundle.js"), "data");
    const app = await createApp({ dataDir: path.join(dir, "data") });
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
    await send("settings", { developmentRoots: [project] });
    const inventory = await fetch(base + "/api/development").then((r) =>
      r.json(),
    );
    const prepare = send("cleanup/prepare", {
      targetId: inventory.targets[0].id,
    });
    let busy = false;
    for (let i = 0; i < 50; i++) {
      if (
        (await fetch(base + "/api/state").then((r) => r.json())).cleanupBusy
      ) {
        busy = true;
        break;
      }
    }
    assert.equal(busy, true);
    assert.equal((await send("scans", { root: project })).status, 409);
    assert.equal(
      (await send("settings", { developmentRoots: [] })).status,
      409,
    );
    assert.equal((await send("shutdown", {})).status, 409);
    const closing = app.close();
    assert.equal((await prepare).status, 200);
    await closing;
    assert.equal(
      await readFile(path.join(target, "bundle.js"), "utf8"),
      "data",
    );
  },
);
test("cleanup from a saved finding resolves only a fully deleted target", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-finding-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"scripts":{"build":"vite build"}}',
  );
  await writeFile(path.join(root, "dist", "bundle.js"), "generated");
  const app = await createApp({ dataDir: path.join(dir, "data") });
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
  const scan = await fetch(base + "/api/scans/" + app.state.scans[0].id).then(
      (r) => r.json(),
    ),
    finding = scan.findings.find((f) => f.path.endsWith("dist"));
  const preview = await send("cleanup/prepare", {
    scanId: scan.id,
    findingId: finding.id,
  }).then((r) => r.json());
  const result = await send("cleanup/execute", {
    id: preview.id,
    confirmation: preview.phrase,
  }).then((r) => r.json());
  assert.equal(result.status, "deleted");
  assert.deepEqual(app.state.reviews[scan.id]?.resolved, [finding.id]);
});
test("targeted operations use selected roots and never start a full-file scan", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-target-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(path.join(root, ".cache"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(path.join(root, "node_modules", "package.dat"), "data");
  const app = await createApp({ dataDir: path.join(dir, "data") });
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
  let response = await send("development", { root, operation: "dependencies" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].category, "dependencies");
  assert.equal(result.coverage.complete, true);
  assert.equal(app.state.scans.length, 0);
  response = await send("development", { root, operation: "caches" });
  assert.equal((await response.json()).targets[0].cleanupSupported, false);
  // Prior operation targets remain known and the selected root need not be a configured default.
  const preview = await send("cleanup/prepare", {
    targetId: result.targets[0].id,
  });
  assert.equal(preview.status, 200);
  assert.equal(
    (await send("development", { root, operation: "unknown" })).status,
    400,
  );
  assert.equal(
    (await send("development", { root: "relative", operation: "builds" }))
      .status,
    400,
  );
});
