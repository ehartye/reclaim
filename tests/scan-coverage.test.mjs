import { test } from "node:test";
import assert from "node:assert/strict";
import { presentScanCoverage } from "../src/scan-coverage.ts";
const scan = (overrides = {}) => ({
  status: "partial",
  skipped: [],
  errors: [],
  notices: [],
  folderSizing: { scopeComplete: false },
  ...overrides,
});
test("drive exclusions stay grouped while actual errors lead and cache failure remains separate", () => {
  const input = scan({
    skipped: Array.from({ length: 1000 }, (_, i) => ({
      path: `fixture/${i}`,
      reason: "Link, offline file or cloud placeholder",
    })),
    errors: [
      { path: "temp", reason: "changed" },
      { path: "system", reason: "denied" },
      { path: "other", reason: "denied" },
    ],
    notices: ["Folder cache could not be saved: Invalid string length"],
  });
  const result = presentScanCoverage(input);
  assert.equal(result.issueCount, 3);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].paths.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.cacheNotices.length, 1);
  assert.match(result.summary, /3 recorded scan issues/);
  assert.match(result.sizeExplanation, /lower bounds/);
  assert.equal(input.status, "partial");
});
test("policy exclusions alone do not claim failure or complete scope", () => {
  const result = presentScanCoverage(
    scan({
      skipped: [{ path: "excluded", reason: "Protected system folder" }],
    }),
  );
  assert.equal(result.issueCount, 0);
  assert.equal(result.label, "Results available");
  assert.match(result.summary, /does not establish complete coverage/);
});
test("unknown skipped reasons stay actionable rather than hidden as policy", () => {
  const result = presentScanCoverage(
    scan({ skipped: [{ path: "unknown", reason: "unrecognized failure" }] }),
  );
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.groups.length, 0);
  assert.equal(result.issueCount, 1);
});
test("cancelled failed and early enumeration errors never become finished", () => {
  for (const status of ["cancelled", "failed"])
    assert.notEqual(presentScanCoverage(scan({ status })).label, "Finished");
  assert.equal(
    presentScanCoverage(
      scan({
        errors: [
          { path: "root", reason: "Folder enumeration did not complete." },
        ],
      }),
    ).label,
    "Review scan issues",
  );
});
test("cached evidence is not described as lower bounds", () => {
  const result = presentScanCoverage(
    scan({ folderSizing: { estimated: true } }),
  );
  assert.match(result.sizeExplanation, /higher or lower/);
  assert.doesNotMatch(result.sizeExplanation, /lower bounds/);
});
test("healthy completed results preserve their outcome and cache notices remain visible", () => {
  assert.equal(
    presentScanCoverage(
      scan({ status: "completed", folderSizing: { scopeComplete: true } }),
    ).label,
    "Finished",
  );
  assert.equal(
    presentScanCoverage(
      scan({
        status: "completed",
        notices: ["Folder cache could not be saved: unavailable"],
      }),
    ).showBanner,
    true,
  );
});
