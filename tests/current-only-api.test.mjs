import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { scan } from "../server/scanner.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-current-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await writeFile(path.join(root, "file.txt"), "current");
  const app = await createApp({ dataDir });
  app.state.settings.developmentRoots = [root];
  t.after(() => app.close());
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (route) => fetch(base + route);
  const state = await (await get("/api/state")).json();
  const post = (route, body = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reclaim-token": state.token,
      },
      body: JSON.stringify(body),
    });
  return { root, dataDir, app, get, post };
}

test("retired endpoints and explicit operations cannot schedule work or mutate state", async (t) => {
  const { root, dataDir, app, get, post } = await fixture(t);
  const before = JSON.stringify(app.state);
  for (const route of [
    "/api/development",
    "/api/development/quick",
    "/api/intelligence",
    "/api/intelligence/start",
    "/api/measurements/start",
    "/api/measurements/cancel",
    "/api/review",
  ]) {
    assert.equal((await get(route)).status, 404, `GET ${route}`);
    assert.equal((await post(route, { root })).status, 404, `POST ${route}`);
  }
  for (const operation of ["full", "duplicates", "development", "", null])
    assert.equal((await post("/api/scans", { root, operation })).status, 400);
  for (const body of [
    { targetId: "old-target" },
    { scanId: "old", findingId: "old-finding" },
    { scanId: "old", directoryPath: root, findingId: "old-finding" },
    { scanId: "old", directoryPath: root, targetId: "old-target" },
  ])
    assert.equal((await post("/api/cleanup/prepare", body)).status, 400);
  assert.equal(JSON.stringify(app.state), before);
  assert.deepEqual(await readdir(dataDir), []);
  assert.equal((await (await get("/api/state")).json()).job, null);
});

test("omitted operation creates a folder report and exports folder rows only", async (t) => {
  const { root, app, get, post } = await fixture(t);
  assert.equal(
    (await post("/api/scans", { root, folderMinBytes: 0 })).status,
    202,
  );
  assert.equal(
    (await post("/api/scans", { root, operation: "full" })).status,
    400,
  );
  for (let i = 0; i < 200 && !app.state.scans.length; i++)
    await new Promise((r) => setTimeout(r, 25));
  assert.equal(app.state.scans.length, 1);
  const summary = app.state.scans[0];
  assert.equal(summary.operation, "folder-sizes");
  const report = await (await get(`/api/scans/${summary.id}`)).json();
  assert(report.folderSizing);
  assert.equal(report.totalBytes, 7);
  const csv = await (await get(`/api/scans/${summary.id}/report.csv`)).text();
  assert.match(csv, /Folder path/);
  assert.doesNotMatch(csv, /Suggested action|Disposition/);
  const exported = await (
    await get(`/api/scans/${summary.id}/report.json`)
  ).json();
  assert.equal(exported.scan.id, summary.id);
  assert.equal(exported.review, undefined);
});

test("unsupported and missing saved payloads return recoverable errors", async (t) => {
  const { dataDir, app, get } = await fixture(t);
  const legacy = "11111111-1111-4111-8111-111111111111";
  const missing = "22222222-2222-4222-8222-222222222222";
  app.state.scans.push({ id: legacy }, { id: missing });
  await writeFile(
    path.join(dataDir, legacy + ".json"),
    JSON.stringify({ id: legacy, findings: [], files: [], directories: [] }),
  );
  for (const suffix of ["", "/report.json", "/report.csv"]) {
    assert.equal((await get(`/api/scans/${legacy}${suffix}`)).status, 400);
    assert.equal((await get(`/api/scans/${missing}${suffix}`)).status, 404);
  }
});

test("scanner itself rejects explicit retired operations", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    scan({ root, operation: "full" }),
    /folder-sizes|supported/i,
  );
});
