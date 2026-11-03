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
test("configured development roots, saved folder targets and confirmed deletion persist through HTTP and restart", async (t) => {
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
  await send("scans", { root, folderMinBytes: 0 });
  for (let i = 0; i < 200; i++) {
    const current = await fetch(base + "/api/state").then((r) => r.json());
    if (!current.job && current.scans.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const scanId = app.state.scans[0].id;
  assert.equal((await send("cleanup/prepare", { path: target })).status, 400);
  assert.equal(
    (
      await send(
        "cleanup/prepare",
        { scanId, directoryPath: target },
        { Origin: "https://foreign.invalid" },
      )
    ).status,
    403,
  );
  r = await send("cleanup/prepare", {
    scanId,
    directoryPath: target,
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
    await send("scans", { root: project, folderMinBytes: 0 });
    for (let i = 0; i < 200; i++) {
      const current = await fetch(base + "/api/state").then((r) => r.json());
      if (!current.job && current.scans.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const prepare = send("cleanup/prepare", {
      scanId: app.state.scans[0].id,
      directoryPath: target,
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
test("cleanup from a saved folder records its completed audit without a review disposition", async (t) => {
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
  await send("scans", { root, folderMinBytes: 0 });
  for (let i = 0; i < 100; i++) {
    if (
      !(await fetch(base + "/api/state").then((r) => r.json())).job &&
      app.state.scans.length
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const scan = await fetch(base + "/api/scans/" + app.state.scans[0].id).then(
      (r) => r.json(),
    ),
    directory = scan.directories.find((f) => f.path.endsWith("dist"));
  const preview = await send("cleanup/prepare", {
    scanId: scan.id,
    directoryPath: directory.path,
  }).then((r) => r.json());
  const result = await send("cleanup/execute", {
    id: preview.id,
    confirmation: preview.phrase,
  }).then((r) => r.json());
  assert.equal(result.status, "deleted");
  assert.equal(app.state.cleanups[0].scanId, scan.id);
  assert.equal(app.state.cleanups[0].status, "deleted");
  assert.equal(app.state.reviews, undefined);
});
