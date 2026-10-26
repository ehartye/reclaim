import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
async function settled(base, count) {
  for (let i = 0; i < 200; i++) {
    const s = await fetch(base + "/api/state").then((r) => r.json());
    if (s.scans.length >= count && !s.job) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Scan did not settle");
}
test("folder-only scans persist aggregate reports and validate operation and strict threshold", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "reclaim-folder-api-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root"),
    dataDir = path.join(temp, "state");
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(path.join(root, "nested", "file"), "1234567890");
  await mkdir(path.join(root, "small"));
  await writeFile(path.join(root, "small", "tiny"), "x");
  let app = await createApp({ dataDir });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await fetch(base + "/api/state").then((r) => r.json());
  const send = (body) =>
    fetch(base + "/api/scans", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": initial.token,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await send({ root, operation: "unknown" })).status, 400);
  assert.equal(
    (await send({ root, operation: "folder-sizes", folderMinBytes: -1 }))
      .status,
    400,
  );
  assert.equal(
    (
      await send({
        root,
        operation: "folder-sizes",
        folderMinBytes: 9,
        maxFiles: 1,
      })
    ).status,
    202,
  );
  await settled(base, 1);
  assert.equal(app.state.scans.length, 1);
  const summary = app.state.scans[0];
  assert.equal(summary.operation, "folder-sizes");
  const report = await fetch(base + "/api/scans/" + summary.id).then((r) =>
    r.json(),
  );
  assert.equal(report.folderSizing.matchingCount, 2);
  assert.equal(report.files.length, 0);
  assert.equal(report.status, "completed");
  const inspect = await fetch(base + "/api/folders/inspect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": initial.token,
    },
    body: JSON.stringify({
      scanId: summary.id,
      path: path.join(root, "nested"),
      limit: 1,
    }),
  });
  assert.equal(inspect.status, 200);
  const listing = await inspect.json();
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].size, 10);
  assert.equal(listing.nextOffset, null);
  const escape = await fetch(base + "/api/folders/inspect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": initial.token,
    },
    body: JSON.stringify({ scanId: summary.id, path: temp }),
  });
  assert.equal(escape.status, 400);
  const preview = await fetch(base + "/api/cleanup/prepare", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": initial.token,
    },
    body: JSON.stringify({
      scanId: summary.id,
      directoryPath: path.join(root, "nested"),
    }),
  });
  assert.equal(preview.status, 409);
  assert.equal(
    (await send({ root, operation: "folder-sizes", folderScanMode: "invalid" }))
      .status,
    400,
  );
  const csv = await fetch(base + `/api/scans/${summary.id}/report.csv`).then(
    (r) => r.text(),
  );
  assert.match(csv, /Folder path/);
  assert.match(csv, /nested/);
  assert.equal(
    await readFile(path.join(root, "nested", "file"), "utf8"),
    "1234567890",
  );
  await send({ root, operation: "folder-sizes", folderMinBytes: 9 });
  await settled(base, 2);
  const quick = await fetch(base + "/api/scans/" + app.state.scans[0].id).then(
    (r) => r.json(),
  );
  assert.equal(quick.folderSizing.estimated, true);
  assert.equal(quick.folderSizing.cachedBranchCount, 1);
  assert.equal(quick.folderSizing.freshFileCount, 1);
  const estimatedCsv = await fetch(
    base + `/api/scans/${quick.id}/report.csv`,
  ).then((r) => r.text());
  assert.match(estimatedCsv, /Estimated mix/);
  await send({
    root,
    operation: "folder-sizes",
    folderMinBytes: 9,
    folderScanMode: "fresh",
  });
  await settled(base, 3);
  const fresh = await fetch(base + "/api/scans/" + app.state.scans[0].id).then(
    (r) => r.json(),
  );
  assert.equal(fresh.folderSizing.estimated, false);
  assert.equal(fresh.folderSizing.cachedBranchCount, 0);
  assert.equal(fresh.folderSizing.freshFileCount, 2);
  await app.close();
  app = await createApp({ dataDir });
  assert.equal(app.state.scans[0].operation, "folder-sizes");
});

test("quick rescans invalidate ancestor cache after an actual confirmed cleanup", async (t) => {
  const temp = await mkdtemp(
    path.join(tmpdir(), "reclaim-tree-cache-cleanup-"),
  );
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "search"),
    project = path.join(root, "project"),
    modules = path.join(project, "node_modules");
  await mkdir(modules, { recursive: true });
  await writeFile(path.join(project, "package.json"), "{}");
  await writeFile(path.join(project, "package-lock.json"), "{}");
  await writeFile(path.join(modules, "data"), "generated");
  const app = await createApp({ dataDir: path.join(temp, "state") });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    state = await fetch(base + "/api/state").then((r) => r.json());
  const send = (route, body) =>
    fetch(base + "/api/" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": state.token,
      },
      body: JSON.stringify(body),
    });
  await send("scans", {
    root,
    operation: "folder-sizes",
    folderMinBytes: 1000,
  });
  await settled(base, 1);
  const scanId = app.state.scans[0].id;
  const preview = await send("cleanup/prepare", {
    scanId,
    directoryPath: modules,
  }).then((r) => r.json());
  assert(preview.id);
  const removed = await send("cleanup/execute", {
    id: preview.id,
    confirmation: preview.phrase,
  }).then((r) => r.json());
  assert.equal(removed.status, "deleted");
  await send("scans", {
    root,
    operation: "folder-sizes",
    folderMinBytes: 1000,
  });
  await settled(base, 2);
  const after = await fetch(base + "/api/scans/" + app.state.scans[0].id).then(
    (r) => r.json(),
  );
  assert.equal(after.totalBytes, 4);
  assert.equal(after.folderSizing.estimated, false);
});

test("tree cleanup previews use existing generated-folder verification and known report scope", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "reclaim-tree-cleanup-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project"),
    modules = path.join(root, "node_modules");
  await mkdir(modules, { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(path.join(modules, "data"), "generated");
  const app = await createApp({ dataDir: path.join(temp, "state") });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    state = await fetch(base + "/api/state").then((r) => r.json());
  const send = (route, body) =>
    fetch(base + "/api/" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": state.token,
      },
      body: JSON.stringify(body),
    });
  await send("scans", { root, operation: "folder-sizes", folderMinBytes: 0 });
  await settled(base, 1);
  const scanId = app.state.scans[0].id;
  const response = await send("cleanup/prepare", {
    scanId,
    directoryPath: modules,
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.phrase, "DELETE node_modules");
  assert.match(preview.restore, /npm ci/);
  assert.equal(await readFile(path.join(modules, "data"), "utf8"), "generated");
  assert.equal(
    (await send("cleanup/prepare", { scanId, directoryPath: temp })).status,
    400,
  );
  await mkdir(path.join(modules, "nested-worktree"));
  await writeFile(
    path.join(modules, "nested-worktree", ".git"),
    "gitdir: missing-repository",
  );
  await writeFile(
    path.join(modules, "nested-worktree", "source.ts"),
    "uncommitted source",
  );
  assert.equal(
    (await send("cleanup/prepare", { scanId, directoryPath: modules })).status,
    409,
  );
  await writeFile(path.join(modules, ".git"), "gitdir: missing-repository");
  assert.equal(
    (await send("cleanup/prepare", { scanId, directoryPath: modules })).status,
    409,
  );
});
