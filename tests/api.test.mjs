import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";

test("HTTP lifecycle persists real scans, folder reports; rejects foreign writes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reclaim-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "workspace");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", "test.bin"),
    Buffer.alloc(2048),
  );
  const revealed = [];
  let revealError = null;
  const app = await createApp({
    dataDir: path.join(dir, "data"),
    revealFolder: async (folder) => {
      if (revealError) throw revealError;
      revealed.push(folder);
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await fetch(base + "/api/state").then((r) => r.json());
  assert(state.token);
  const send = (url, body, extra = {}) =>
    fetch(base + url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": state.token,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send("/api/scans", { root }, { Origin: "https://evil.example" }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(base + "/api/settings", { method: "POST", body: "{}" }))
      .status,
    403,
  );
  assert.equal((await send("/api/scans", { root: "relative" })).status, 400);
  assert.equal(
    (await send("/api/scans", { root, folderMinBytes: -1 })).status,
    400,
  );
  const starts = await Promise.all(
    Array.from({ length: 6 }, () =>
      send("/api/scans", { root, folderMinBytes: 1 }),
    ),
  );
  assert.deepEqual(
    starts.map((r) => r.status).sort(),
    [202, 409, 409, 409, 409, 409],
  );
  let current;
  for (let i = 0; i < 100; i++) {
    current = await fetch(base + "/api/state").then((r) => r.json());
    if (!current.job) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(current.scans.length, 1);
  assert.equal(current.scans[0].totalBytes, 2048);
  const scan = await fetch(base + "/api/scans/" + current.scans[0].id).then(
    (r) => r.json(),
  );
  assert(scan.folderSizing);
  const csv = await fetch(base + `/api/scans/${scan.id}/report.csv`).then((r) =>
    r.text(),
  );
  assert.match(csv, /Folder path/);
  const report = await fetch(base + `/api/scans/${scan.id}/report.json`).then(
    (r) => r.json(),
  );
  assert.equal(report.scan.id, scan.id);
  const reveal = await send("/api/reveal", {
    scanId: scan.id,
    path: path.join(root, "node_modules"),
  });
  assert.equal(reveal.status, 200);
  assert.equal((await reveal.json()).folder, path.join(root, "node_modules"));
  assert.equal(
    (await send("/api/reveal", { scanId: scan.id, path: root })).status,
    200,
  );
  assert.deepEqual(revealed, [path.join(root, "node_modules"), root]);
  revealError = new Error("Windows could not open this folder");
  const rejected = await send("/api/reveal", {
    scanId: scan.id,
    path: path.join(root, "node_modules"),
  });
  assert.equal(rejected.status, 500);
  assert.match((await rejected.json()).error, /Windows could not open/);
  assert.equal(
    (
      await send("/api/reveal", {
        scanId: scan.id,
        path: "C:/unknown/not-scanned",
      })
    ).status,
    400,
  );
  assert.equal(
    (await send("/api/settings", { exclusions: ["secrets"], skipCloud: false }))
      .status,
    200,
  );
  const blockedTemp = path.join(dir, "data", "state.tmp");
  await mkdir(blockedTemp);
  assert.equal((await send("/api/settings", { skipCloud: true })).status, 500);
  await rmdir(blockedTemp);
  assert.equal(
    (await send("/api/settings", { skipCloud: false })).status,
    200,
    "Persistence recovers after a temporary write failure",
  );
  await app.close();
  const reopened = await createApp({ dataDir: path.join(dir, "data") });
  t.after(() => reopened.close());
  assert.equal(reopened.state.settings.skipCloud, false);
  assert.equal(reopened.state.scans.length, 1);
});
