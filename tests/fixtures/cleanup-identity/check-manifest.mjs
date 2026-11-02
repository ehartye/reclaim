import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function checkManifest() {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.schema, "reclaim.cleanup-identity-fixtures/1");
  assert.deepEqual(manifest.lanes, ["generated", "git-worktree-unforced"]);
  assert.deepEqual(manifest.limits, {
    entries: 250000, retainedHandles: 512,
    operationMilliseconds: 60000, drainWatchdogMilliseconds: 5000,
  });
  assert.match(manifest.roles.rootPrefix, /^reclaim-cleanup-identity-$/);
  for (const [role, value] of Object.entries(manifest.roles)) {
    if (role === "rootPrefix") continue;
    assert.equal(typeof value, "string");
    assert(!path.isAbsolute(value), `Absolute fixture role: ${role}`);
    assert(!value.split(/[\\/]/).some((part) => part === ".." || !part), `Escaping fixture role: ${role}`);
    assert(!/[\x00-\x1f:]/.test(value), `Invalid fixture role: ${role}`);
  }
  assert(!manifest.roles.outsidePreview.startsWith(`${manifest.roles.target}/`));
  assert(!manifest.roles.preservedTarget.startsWith(`${manifest.roles.target}/`));
  assert.equal(manifest.baseline.expectedVerdict, "Invalidated");
  assert.equal(manifest.baseline.outsidePreviewFileDeleted, true);
  assert.equal(manifest.baseline.previewedFileRetained, true);
  for (const collection of [manifest.nativeBoundarySchedule, manifest.requiredCases, manifest.invariants]) {
    assert(Array.isArray(collection) && collection.length > 0);
    assert.equal(new Set(collection).size, collection.length);
    assert(collection.every((item) => typeof item === "string" && item.length > 0));
  }
  for (const boundary of ["root-open", "ancestor-open", "entry-open", "identity-check", "policy-check", "file-disposition", "directory-removal"]) {
    assert(manifest.nativeBoundarySchedule.includes(`before-${boundary}`));
    assert(manifest.nativeBoundarySchedule.includes(`after-${boundary}`));
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkManifest();
  console.log("cleanup identity manifest: valid (read only; no fixture or product writes)");
}
