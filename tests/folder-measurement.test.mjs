import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  link,
  symlink,
  rm,
  utimes,
  readFile,
  statfs,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { measureFolder } from "../server/folder-measurement.mjs";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-measure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "generated");
  await mkdir(target);
  return { root, target };
}
test("fresh measurement reports exclusive allocation, logical bytes and activity without reading contents", async (t) => {
  const { target } = await fixture(t);
  const before = Date.now();
  await writeFile(
    path.join(target, "large.bin"),
    Buffer.alloc(2 * 1024 ** 2, 7),
  );
  const r = await measureFolder({ path: target });
  assert.equal(r.status, "complete");
  assert.equal(r.logicalBytes, 2 * 1024 ** 2);
  assert.equal(r.fileCount, 1);
  assert(r.newestActivityAt >= before - 2000);
  assert.equal(r.basis, "allocated");
  assert(r.allocatedBytes > 0);
  assert.equal(r.exclusiveAllocatedBytes, r.allocatedBytes);
  assert.equal(r.sharedAllocatedBytes, 0);
  assert.match(r.notices.join(" "), /estimate|guarantee/i);
});
test("known shared hardlinks are deduplicated and discounted from exclusive potential gain", async (t) => {
  const { root, target } = await fixture(t);
  const file = path.join(target, "shared.bin");
  await writeFile(file, Buffer.alloc(1024 ** 2, 8));
  await link(file, path.join(target, "second-link.bin"));
  await link(file, path.join(root, "outside-link.bin"));
  const r = await measureFolder({ path: target });
  assert.equal(r.status, "complete");
  assert.equal(r.logicalBytes, 1024 ** 2);
  assert.equal(r.fileCount, 1);
  assert.equal(r.exclusiveAllocatedBytes, 0);
  assert.equal(r.sharedAllocatedBytes, r.allocatedBytes);
  assert(r.sharedAllocatedBytes > 0);
});
test(
  "ordinary NTFS files report cluster allocation rather than end-of-file length",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { target } = await fixture(t);
    const cluster = (await statfs(target)).bsize;
    const logical = cluster + 1;
    await writeFile(
      path.join(target, "ordinary.bin"),
      Buffer.alloc(logical, 9),
    );
    const r = await measureFolder({ path: target });
    assert.equal(r.status, "complete");
    assert.equal(r.logicalBytes, logical);
    assert(
      r.allocatedBytes > logical,
      "Ordinary file allocation includes the partially used final cluster.",
    );
    assert.equal(r.allocatedBytes % cluster, 0);
    assert.equal(r.exclusiveAllocatedBytes, r.allocatedBytes);
  },
);
test("zero allocated data remains a measured zero instead of an unavailable estimate", async (t) => {
  const { target } = await fixture(t);
  await writeFile(path.join(target, "empty.bin"), "");
  const r = await measureFolder({ path: target });
  assert.equal(r.status, "complete");
  assert.equal(r.logicalBytes, 0);
  assert.equal(r.allocatedBytes, 0);
  assert.equal(r.exclusiveAllocatedBytes, 0);
  assert.equal(r.basis, "allocated");
});
test("preserved old package modification times do not conceal recent creation or nested activity", async (t) => {
  const { target } = await fixture(t),
    before = Date.now();
  const nested = path.join(target, "package", "lib");
  await mkdir(nested, { recursive: true });
  const file = path.join(nested, "old-package.js");
  await writeFile(file, "old package timestamp");
  await utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
  await utimes(target, new Date("2020-01-01"), new Date("2020-01-01"));
  const r = await measureFolder({ path: target });
  assert.equal(r.status, "complete");
  assert(r.newestActivityAt >= before - 2000);
  assert.equal(await readFile(file, "utf8"), "old package timestamp");
});
test("junctions are not followed and linked ancestors cannot be used as measurement roots", async (t) => {
  const { root, target } = await fixture(t),
    outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "valuable.bin"), Buffer.alloc(1024 ** 2));
  const shortcut = path.join(target, "escape");
  await symlink(
    outside,
    shortcut,
    process.platform === "win32" ? "junction" : "dir",
  );
  const r = await measureFolder({ path: target });
  assert.equal(r.status, "partial");
  assert.equal(r.logicalBytes, 0);
  assert(r.skippedCount > 0);
  assert.match(r.notices.join(" "), /link|junction|reparse/i);
  const child = path.join(outside, "child");
  await mkdir(child);
  const nested = await measureFolder({ path: path.join(shortcut, "child") });
  assert.equal(nested.status, "partial");
  assert.equal(nested.fileCount, 0);
});
test("cancelled and elapsed budgets are explicit incomplete measurements", async (t) => {
  const { target } = await fixture(t);
  await writeFile(path.join(target, "file"), "data");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await measureFolder({
    path: target,
    signal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.fileCount, 0);
  const deadline = await measureFolder({ path: target, timeoutMs: 0 });
  assert.equal(deadline.status, "partial");
  assert.match(deadline.notices.join(" "), /time|budget/i);
});
test("missing paths return an incomplete result, never an authoritative zero-sized folder", async (t) => {
  const { root } = await fixture(t);
  const r = await measureFolder({ path: path.join(root, "missing") });
  assert.equal(r.status, "partial");
  assert(r.errorCount > 0);
  assert.match(r.notices.join(" "), /missing|find|exist|not found/i);
});
test(
  "a fully old subtree retains its verified activity date",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { target } = await fixture(t);
    const nested = path.join(target, "lib");
    await mkdir(nested);
    await writeFile(path.join(nested, "built.bin"), Buffer.alloc(8192));
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';$p=[Console]::ReadLine();$at=[DateTime]::Parse('2020-01-01T00:00:00Z').ToUniversalTime();$items=@([IO.Directory]::EnumerateFileSystemEntries($p,'*',[IO.SearchOption]::AllDirectories));foreach($i in $items){if([IO.Directory]::Exists($i)){[IO.Directory]::SetCreationTimeUtc($i,$at);[IO.Directory]::SetLastWriteTimeUtc($i,$at)}else{[IO.File]::SetCreationTimeUtc($i,$at);[IO.File]::SetLastWriteTimeUtc($i,$at)}};[IO.Directory]::SetCreationTimeUtc($p,$at);[IO.Directory]::SetLastWriteTimeUtc($p,$at)",
      ],
      { windowsHide: true, input: target + "\n" },
    );
    const r = await measureFolder({ path: target });
    assert.equal(r.status, "complete");
    assert.equal(r.newestActivityAt, Date.parse("2020-01-01T00:00:00Z"));
  },
);
test("an active measurement emits bounded progress and stops after cancellation", async (t) => {
  const { target } = await fixture(t);
  await Promise.all(
    Array.from({ length: 1500 }, (_, i) =>
      writeFile(path.join(target, `${i}.bin`), "data"),
    ),
  );
  const controller = new AbortController();
  let updates = 0;
  const r = await measureFolder({
    path: target,
    signal: controller.signal,
    onProgress: (p) => {
      updates++;
      assert(p.fileCount >= 1000);
      controller.abort();
    },
  });
  assert(updates >= 1);
  assert.equal(r.status, "cancelled");
  assert(r.fileCount >= 1000);
  assert.match(r.notices.join(" "), /cancelled/i);
});
