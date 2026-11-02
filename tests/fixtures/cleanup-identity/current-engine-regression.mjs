// A known-unsafe baseline, deliberately isolated from ordinary application code.
// No caller-supplied root or target is accepted. All mutation uses this process's
// unique temporary fixture. A passing command means the audit failure reproduced.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, release, arch } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { createCleanup } from "../../../server/cleanup.mjs";
import { checkManifest } from "./check-manifest.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = await checkManifest();
const root = await fs.mkdtemp(path.join(tmpdir(), manifest.roles.rootPrefix));
const rootIdentity = await fs.lstat(root, { bigint: true });
const rootReal = await fs.realpath(root);
const temporaryReal = await fs.realpath(tmpdir());
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const runDirectory = path.join(repoRoot, "review", "cleanup-identity", randomUUID());
await fs.mkdir(runDirectory, { recursive: true });
const originalUnlink = fs.unlink;
let safeToTeardown = false;
let engine;
const trace = [];
const records = [];
const tick = (event, data = {}) => trace.push({ event, nanoseconds: process.hrtime.bigint().toString(), ...data });
const role = (name) => {
  const result = path.resolve(root, manifest.roles[name]);
  assert(result.startsWith(`${path.resolve(root)}${path.sep}`), "Fixture path escaped owned root");
  return result;
};
async function observe(file) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink(), "Expected ordinary fixture file");
    const bytes = await fs.readFile(file);
    return { exists: true, dev: String(stat.dev), ino: String(stat.ino), bytes: bytes.length, sha256: hash(bytes) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { exists: false };
  }
}
async function writeJson(name, value) {
  await fs.writeFile(path.join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

try {
  assert.equal(process.argv.length, 2, "This fixture accepts no arbitrary paths or flags");
  assert(path.resolve(rootReal).startsWith(`${path.resolve(temporaryReal)}${path.sep}`));
  assert(path.basename(root).startsWith(manifest.roles.rootPrefix));
  const target = role("target"), outside = role("outsidePreview"), preserved = role("preservedTarget");
  const payload = path.join(target, manifest.roles.payload);
  const outsidePayload = path.join(outside, manifest.roles.payload);
  const preservedPayload = path.join(preserved, manifest.roles.payload);
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(role("project"), "package.json"), JSON.stringify({ scripts: { build: "fixture-only" } }));
  await fs.writeFile(payload, "previewed generated output");
  await fs.writeFile(outsidePayload, "personal data outside selected target");
  const before = { previewed: await observe(payload), outside: await observe(outsidePayload) };
  tick("fixture-ready", { before });
  engine = createCleanup({ onRecord: async (record) => {
    records.push(structuredClone(record));
    tick("operation-record", { status: record.status, deletedFiles: record.deletedFiles });
  } });
  const preview = await engine.prepare(target);
  tick("prepared", { fileCount: preview.fileCount, bytes: preview.bytes });
  let swapped = false;
  fs.unlink = async (file) => {
    if (!swapped && file === payload) {
      tick("final-unlink-boundary", { path: file });
      await fs.rename(target, preserved);
      await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
      swapped = true;
      tick("target-replaced-with-fixture-junction");
    }
    return originalUnlink(file);
  };
  syncBuiltinESMExports();
  const receipt = await engine.execute(preview.id, preview.phrase);
  fs.unlink = originalUnlink;
  syncBuiltinESMExports();
  // A settled successful execute has awaited all current-engine inspections.
  // No mutative native helper or background mutator is launched in this package.
  assert.equal(engine.running, false);
  safeToTeardown = true;
  const after = { outside: await observe(outsidePayload), previewedAtPreservedPath: await observe(preservedPayload) };
  tick("independent-filesystem-observation", { after });
  const result = {
    schema: "reclaim.cleanup-identity-baseline/1",
    method: manifest.baseline.method,
    strategyVerdict: "Invalidated",
    scope: "Current JS baseline only; no native or Git qualification",
    host: { platform: process.platform, osRelease: release(), architecture: arch(), node: process.version,
      git: execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).trim() },
    fixture: { root, rootReal, rootIdentity: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) } },
    swapped, before, after, operationReceipt: receipt, operationRecords: records,
    observedOutsidePreviewDeletion: !after.outside.exists,
    observedPreviewedFileRetained: after.previewedAtPreservedPath.sha256 === before.previewed.sha256 &&
      after.previewedAtPreservedPath.ino === before.previewed.ino,
    trace,
  };
  await writeJson("receipt.json", result);
  assert.equal(swapped, true);
  assert.equal(result.observedOutsidePreviewDeletion, manifest.baseline.outsidePreviewFileDeleted);
  assert.equal(result.observedPreviewedFileRetained, manifest.baseline.previewedFileRetained);
  assert.equal(receipt.status, manifest.baseline.expectedOperationStatus);
  assert.equal(receipt.deletedFiles, manifest.baseline.expectedDeletedFiles);
  assert.match(receipt.error, /link|junction/i);
  assert.deepEqual(records.map((record) => record.status), ["started", "partial"]);
  console.log(JSON.stringify({ reproduced: true, strategyVerdict: result.strategyVerdict, operationStatus: receipt.status, receipt: path.join(runDirectory, "receipt.json") }));
} catch (error) {
  await writeJson("harness-error.json", { message: error.message, stack: error.stack, root, safeToTeardown, trace });
  throw error;
} finally {
  fs.unlink = originalUnlink;
  syncBuiltinESMExports();
  let teardown = "retained: helper/operation completion was not established";
  if (safeToTeardown && !engine?.running) {
    const currentRoot = await fs.lstat(root, { bigint: true });
    assert(!currentRoot.isSymbolicLink() && currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino);
    assert.equal(await fs.realpath(root), rootReal);
    assert(path.resolve(rootReal).startsWith(`${path.resolve(temporaryReal)}${path.sep}`));
    assert(path.basename(root).startsWith(manifest.roles.rootPrefix));
    // Remove the junction link first, so recursive teardown never traverses it.
    const target = role("target");
    const targetStat = await fs.lstat(target).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (targetStat?.isSymbolicLink()) await originalUnlink(target);
    await fs.rm(root, { recursive: true, force: true });
    teardown = "removed after settled operation and owned-root identity recheck";
  }
  await writeJson("teardown.json", { root, safeToTeardown, outcome: teardown });
  const inventory = [];
  for (const relative of ["receipt.json", "harness-error.json", "teardown.json"]) {
    const filename = path.join(runDirectory, relative);
    const bytes = await fs.readFile(filename).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (bytes) inventory.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  const sources = [];
  for (const relative of ["server/cleanup.mjs", "server/windows-cleanup-check.ps1", "tests/fixtures/cleanup-identity/manifest.json", "tests/fixtures/cleanup-identity/check-manifest.mjs", "tests/fixtures/cleanup-identity/current-engine-regression.mjs"]) {
    const bytes = await fs.readFile(path.join(repoRoot, relative));
    sources.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  await writeJson("evidence-inventory.json", { schema: "reclaim.experiment-evidence/1", artifacts: inventory, sources });
}
