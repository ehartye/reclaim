import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  link,
  symlink,
  rm,
  lstat,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scan } from "../server/scanner.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (p, content, old = false) => {
    const full = path.join(root, p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    if (old) await utimes(full, new Date("2020-01-01"), new Date("2020-01-01"));
    return full;
  };
  return { root, put };
}

test("directory links never escape the chosen root and exclusions are honored", async (t) => {
  const { root, put } = await fixture(t);
  await put("keep.txt", "abc");
  await put("excluded/secret.txt", "hidden");
  await symlink(
    path.join(root, "excluded"),
    path.join(root, "redirect"),
    "junction",
  );
  const r = await scan({ root, exclusions: ["excluded"] });
  assert.equal(r.totalBytes, 3);
  assert(r.skipped.some((s) => /redirect$/.test(s.path)));
  assert(r.skipped.some((s) => /excluded$/.test(s.path)));
});

test(
  "Windows scans reject linked ancestors even when the selected leaf is a regular directory",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, put } = await fixture(t);
    await put("actual/inner/data.bin", "not to be read");
    await symlink(
      path.join(root, "actual"),
      path.join(root, "alias"),
      "junction",
    );
    const result = await scan({ root: path.join(root, "alias", "inner") });
    assert.equal(result.totalBytes, 0);
    assert.equal(result.status, "partial");
    assert(
      [...result.skipped, ...result.errors].some((s) =>
        /ancestor|link/i.test(s.reason),
      ),
    );
  },
);

test("absolute exclusions accept Windows forward slashes and trailing separators", async (t) => {
  const { root, put } = await fixture(t);
  await put("excluded/data.bin", "secret");
  await put("included.txt", "ok");
  const result = await scan({
    root,
    exclusions: [path.join(root, "excluded").replaceAll("\\", "/") + "/"],
  });
  assert.equal(result.totalBytes, 2);
  assert(result.skipped.some((s) => /excluded$/.test(s.path)));
});

test("Unicode roots and names scan correctly and preserve exact filesystem identity", async (t) => {
  const { root, put } = await fixture(t);
  const target = await put("é雪/ñë.txt", "abc");
  const result = await scan({ root: path.join(root, "é雪") });
  const stat = await lstat(target, { bigint: true });
  assert.equal(result.totalBytes, 3);
  assert.equal(result.status, "completed");
  assert.equal(result.directories[0].path, path.dirname(target));
});

test("long Windows paths and project folders named windows remain in scan coverage", async (t) => {
  const { root, put } = await fixture(t);
  await put("project/windows/valuable.txt", "keep");
  await put(
    Array(6).fill("long-directory-name-".repeat(2)).join("/") + "/deep.txt",
    "deep",
  );
  const result = await scan({ root });
  assert.equal(result.totalBytes, 8);
  assert.equal(result.errors.length, 0);
});

test("cancellation interrupts an active filesystem enumeration and returns partial evidence", async (t) => {
  const { root, put } = await fixture(t);
  await put("one.bin", "content");
  const controller = new AbortController();
  let observed = false;
  const result = await scan(
    { root },
    {
      signal: controller.signal,
      onProgress: () => {
        observed = true;
        controller.abort();
      },
    },
  );
  assert(observed);
  assert.equal(result.status, "cancelled");
});
