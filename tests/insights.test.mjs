import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { enrichFindings } from "../server/insights.mjs";
test("saved findings gain current restore evidence and package/application context without changing recorded sizes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-insight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "node_modules");
  await mkdir(target);
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const original = [
    {
      id: "modules",
      category: "dependencies",
      path: target,
      bytes: 100,
      risk: "low",
    },
    {
      id: "dup",
      category: "duplicates",
      path: path.join(target, "copy.d.ts"),
      bytes: 5,
      risk: "review",
    },
    {
      id: "dll",
      category: "large",
      path: path.join(root, "tool.dll"),
      bytes: 200,
      risk: "review",
    },
  ];
  const findings = await enrichFindings(original);
  assert.match(findings[0].insight.restore, /npm ci/);
  assert.equal(findings[0].bytes, 100);
  assert.match(findings[1].insight.reason, /package|generated/i);
  assert.match(findings[2].insight.restore, /uninstall|application/i);
  assert.equal(original[0].insight, undefined);
});
