import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodeFolderCache,
  saveFolderCache,
  loadFolderCache,
  FOLDER_CACHE_LIMITS,
} from "../server/folder-cache.mjs";
const date = "2026-01-01T00:00:00.000Z";
const row = (name, extra = {}) => ({
  path: name,
  bytes: 8,
  fileCount: 1,
  directoryCount: 1,
  stamp: 10,
  birthStamp: 5,
  complete: true,
  estimated: false,
  measuredAt: date,
  ...extra,
});
const result = (directories) => ({ directories, startedAt: date });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-cache-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { root } };
}
test("cache bounds compact records in UTF-8 bytes without serializing irrelevant report data", () => {
  const directories = Array.from({ length: 200 }, (_, i) =>
    row("/é/".repeat(20) + i, {
      unrelated: {
        toJSON() {
          throw Error("must not serialize");
        },
      },
    }),
  );
  const encoded = encodeFolderCache([], result(directories), {
    maxBytes: 1000,
    maxRecords: 8,
  });
  assert(Buffer.byteLength(encoded) <= 1000);
  const records = JSON.parse(encoded).records;
  assert(records.length > 0 && records.length < 8);
  assert(!("unrelated" in records[0]));
  assert.equal(
    JSON.parse(
      encodeFolderCache([], result(directories), {
        maxBytes: 8000,
        maxRecords: 2,
      }),
    ).records.length,
    2,
  );
});
test("cache invalidation runs after budget exhaustion and never promotes estimated rows", () => {
  const previous = [row("/bad"), row("/reuse"), row("/bad-estimated")];
  const encoded = encodeFolderCache(
    previous,
    result([
      row("/new"),
      row("/bad", { complete: false }),
      row("/reuse", { estimated: true, bytes: 999 }),
      row("/bad-estimated", { complete: false, estimated: true }),
    ]),
    { maxBytes: 1000, maxRecords: 3 },
  );
  const records = JSON.parse(encoded).records;
  assert.deepEqual(
    records.map((r) => r.path),
    ["/new", "/reuse"],
  );
  assert.equal(records[1].bytes, 8);
  assert.equal(records[1].measuredAt, date);
  const full = JSON.parse(
    encodeFolderCache(
      previous,
      result([row("/new"), row("/bad", { complete: false })]),
      { maxBytes: 1000, maxRecords: 1 },
    ),
  );
  assert.deepEqual(
    full.records.map((r) => r.path),
    ["/new"],
  );
});
test("cache round-trip preserves cleanup invalidation and rejects oversized legacy files before parsing", async (t) => {
  const { root, options } = await fixture(t);
  await saveFolderCache(root, options, [], result([row(root)]));
  assert.equal((await loadFolderCache(root, options)).length, 1);
  await writeFile(
    path.join(root, "state.json"),
    JSON.stringify({
      cleanups: [{ path: root, completedAt: "2026-02-01T00:00:00.000Z" }],
    }),
  );
  assert.deepEqual(await loadFolderCache(root, options), []);
  await rm(path.join(root, "state.json"));
  const file = path.join(
    root,
    "intelligence",
    (await readdir(path.join(root, "intelligence")))[0],
  );
  const handle = await open(file, "w");
  await handle.truncate(FOLDER_CACHE_LIMITS.maxBytes + 1);
  await handle.close();
  assert.deepEqual(await loadFolderCache(root, options), []);
  await saveFolderCache(root, options, [], result([row(root)]));
  assert.equal((await loadFolderCache(root, options)).length, 1);
});
test("failed cache preparation preserves existing cache and rename failure cleans only its own temporary file", async (t) => {
  const { root, options } = await fixture(t);
  await saveFolderCache(root, options, [], result([row(root)]));
  const dir = path.join(root, "intelligence");
  const file = path.join(dir, (await readdir(dir))[0]);
  const before = await readFile(file);
  await assert.rejects(
    saveFolderCache(root, options, [], {
      get directories() {
        throw Error("fixture failure");
      },
    }),
  );
  assert.deepEqual(await readFile(file), before);
  await rm(file);
  await mkdir(file);
  await writeFile(path.join(file, "sentinel"), "unchanged");
  await assert.rejects(saveFolderCache(root, options, [], result([row(root)])));
  assert.deepEqual(await readdir(dir), [path.basename(file)]);
  assert.equal(
    await readFile(path.join(file, "sentinel"), "utf8"),
    "unchanged",
  );
});
