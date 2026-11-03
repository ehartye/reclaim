import { test } from "node:test";
import assert from "node:assert/strict";
import { parent, scanDelta } from "../src/types.ts";
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
