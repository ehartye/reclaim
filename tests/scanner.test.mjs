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
import { selectedBytes } from "../server/analysis.mjs";

test("package internals are not offered as duplicate cleanup and installed DLLs carry application advice", async (t) => {
  const { root, put } = await fixture(t);
  await put("app/package.json", "{}");
  await put("app/package-lock.json", '{"lockfileVersion":3}');
  await put("app/node_modules/one.dat", "same");
  await put("app/node_modules/two.dat", "same");
  await put("tools/editor/component.dll", "x".repeat(20), true);
  const r = await scan({
    root,
    minimumBytes: 1,
    duplicates: true,
    duplicateMinBytes: 1,
    largeFileBytes: 10,
  });
  assert.equal(r.findings.filter((f) => f.category === "duplicates").length, 0);
  assert.match(
    r.findings.find((f) => f.path.endsWith("component.dll")).action,
    /uninstall|application/i,
  );
});

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

test("real scan identifies dependencies, old installers, and large stale files with evidence", async (t) => {
  const { root, put } = await fixture(t);
  await put("app/package.json", "{}");
  await put("app/node_modules/lib/index.js", "x".repeat(128));
  await put("downloads/setup.exe", "i".repeat(64), true);
  await put("notes/valuable.dat", "v".repeat(80), true);
  const r = await scan({ root, largeFileBytes: 70, minimumBytes: 1 });
  assert.equal(r.status, "completed");
  assert.equal(r.totalBytes, 274);
  assert(
    r.findings.some(
      (f) =>
        f.category === "dependencies" &&
        f.bytes === 128 &&
        /install/i.test(f.action),
    ),
  );
  assert(
    r.findings.some(
      (f) => f.category === "installers" && /setup.exe$/.test(f.path),
    ),
  );
  assert(
    r.findings.some(
      (f) =>
        f.category === "large" &&
        /valuable.dat$/.test(f.path) &&
        f.risk === "review",
    ),
  );
  assert(r.findings.every((f) => f.reason && f.impact && f.evidence.length));
});

test("files changed during duplicate reads are not reported as verified copies", async (t) => {
  const { root, put } = await fixture(t);
  const content = Buffer.alloc(32 * 1024 ** 2, 8);
  await put("first.bin", content);
  await put("second.bin", content);
  let mutation,
    changedAt = 0;
  const result = await scan(
    { root, duplicates: true, duplicateMinBytes: 1 },
    {
      onProgress: (p) => {
        if (
          p.phase === "Verifying duplicates" &&
          p.current.endsWith(".bin") &&
          !mutation
        ) {
          mutation = (async () => {
            await new Promise((r) => setTimeout(r, 5));
            const handle = await open(p.current, "r+");
            try {
              await handle.write(Buffer.from([9]), 0, 1, 0);
            } finally {
              await handle.close();
            }
            changedAt = Date.now();
          })();
        }
      },
    },
  );
  await mutation;
  assert(mutation, "Observed duplicate content reads");
  assert(
    changedAt <= Date.parse(result.completedAt),
    "Mutation occurred before verification completed",
  );
  assert.equal(result.duplicateGroups.length, 0);
});

test("duplicates are full-content verified, preserve one keeper, and exclude hardlinks", async (t) => {
  const { root, put } = await fixture(t);
  const first = await put("a.bin", "same content".repeat(10));
  await put("b.bin", "same content".repeat(10));
  await put("different.bin", "other string".repeat(10));
  await put("c.bin", "same content".repeat(10));
  await link(first, path.join(root, "hardlink.bin"));
  const r = await scan({
    root,
    duplicates: true,
    duplicateMinBytes: 1,
    minimumBytes: 1,
  });
  assert.equal(r.totalBytes, 480);
  assert.equal(r.duplicateGroups.length, 1);
  assert.equal(r.duplicateGroups[0].files.length, 2);
  assert.equal(r.duplicateGroups[0].bytes, 120);
  assert.equal(r.duplicateGroups[0].hash.length, 64);
});

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

test("bounded scans and cancellation are explicit partial states", async (t) => {
  const { root, put } = await fixture(t);
  await put("one.txt", "1");
  await put("two.txt", "2");
  const limited = await scan({ root, maxFiles: 1 });
  assert.equal(limited.status, "partial");
  assert.match(limited.notices.join(" "), /limit/i);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await scan({ root }, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
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
    assert(result.skipped.some((s) => /ancestor|link/i.test(s.reason)));
  },
);

test("selection totals union nested paths and duplicate memberships without double counting", () => {
  const files = [
    { path: "C:/work/cache/a", size: 10 },
    { path: "C:/work/cache/b", size: 20 },
    { path: "C:/work/other", size: 10 },
  ];
  const findings = [
    { id: "dir", filePaths: files.slice(0, 2).map((f) => f.path) },
    { id: "dup", filePaths: [files[0].path, files[2].path] },
  ];
  assert.equal(selectedBytes(findings, ["dir", "dup"], files), 40);
});

test("hash budget is explicit and never calls unhashed candidates verified duplicates", async (t) => {
  const { root, put } = await fixture(t);
  await put("one.bin", "matching");
  await put("two.bin", "matching");
  const r = await scan({
    root,
    duplicates: true,
    duplicateMinBytes: 1,
    hashBudgetBytes: 1,
  });
  assert.equal(r.duplicateGroups.length, 0);
  assert(r.notices.some((n) => /hash.*budget/i.test(n)));
});

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

test("dependency folders without a manifest require review rather than claiming recoverability", async (t) => {
  const { root, put } = await fixture(t);
  await put("node_modules/vendor/source.js", "important code");
  const result = await scan({ root, minimumBytes: 1 });
  assert.equal(result.findings[0].risk, "review");
  assert.match(result.findings[0].reason, /no .*manifest/i);
});

test("Unicode roots and names scan correctly and preserve exact filesystem identity", async (t) => {
  const { root, put } = await fixture(t);
  const target = await put("é雪/ñë.txt", "abc");
  const result = await scan({ root: path.join(root, "é雪") });
  const stat = await lstat(target, { bigint: true });
  assert.equal(result.totalBytes, 3);
  assert.equal(result.status, "completed");
  assert.equal(result.files[0].identity, `${stat.dev}:${stat.ino}`);
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

test("recognizes engine build caches and language package caches using project evidence", async (t) => {
  const { root, put } = await fixture(t);
  await put("game/Assets/scene.unity", "source");
  await put("game/ProjectSettings/settings.asset", "source");
  await put("game/Library/data.bin", "generated");
  await put("godot/project.godot", "source");
  await put("godot/.godot/cache.bin", "generated");
  await put("dotnet/app.csproj", "source");
  await put("dotnet/obj/data.bin", "generated");
  await put(".nuget/packages/package/data.bin", "downloaded");
  await put(".m2/repository/local/library.bin", "unpublished");
  await put("python/.venv/pyvenv.cfg", "config");
  await put("python/.venv/installed.py", "important");
  const result = await scan({ root, minimumBytes: 1 });
  for (const suffix of ["Library", ".godot", "obj", "packages"])
    assert(
      result.findings.some((f) => f.path.endsWith(suffix)),
      suffix,
    );
  assert.equal(
    result.findings.find((f) => f.path.endsWith(".venv")).risk,
    "review",
  );
  const maven = result.findings.find((f) => f.path.endsWith("repository"));
  assert.equal(maven.risk, "review");
  assert.match(maven.impact, /unpublished/i);
});
