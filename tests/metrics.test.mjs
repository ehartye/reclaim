import { test } from "node:test";
import assert from "node:assert/strict";
import { categorySizes, parent, scanDelta } from "../src/types.ts";
test("visual category totals partition files even when a duplicate overlaps a directory finding", () => {
  const scan = {
    files: [
      { path: "a", size: 100 },
      { path: "b", size: 100 },
      { path: "c", size: 50 },
    ],
    findings: [
      { id: "deps", category: "dependencies", filePaths: ["a", "b"] },
      { id: "dup", category: "duplicates", filePaths: ["b", "c"] },
    ],
  };
  const totals = categorySizes(scan, scan.findings);
  assert.equal(
    Object.values(totals).reduce((a, b) => a + b, 0),
    250,
  );
  assert.equal(totals.dependencies, 200);
  assert.equal(totals.duplicates, 50);
});
test("map parent preserves Windows drive roots and POSIX roots", () => {
  assert.equal(parent("C:\\file"), "C:\\");
  assert.equal(parent("C:\\"), "C:\\");
  assert.equal(parent("/file"), "/");
  assert.equal(parent("/"), "/");
});
test("history compares equivalent complete coverage only", () => {
  const first = { status: "completed", coverageKey: "same", totalBytes: 100 };
  assert.equal(scanDelta({ ...first, totalBytes: 125 }, first), 25);
  assert.equal(
    scanDelta({ ...first, status: "cancelled", totalBytes: 1 }, first),
    null,
  );
  assert.equal(scanDelta({ ...first, coverageKey: "different" }, first), null);
  assert.equal(scanDelta(first, { ...first, status: "partial" }), null);
});
