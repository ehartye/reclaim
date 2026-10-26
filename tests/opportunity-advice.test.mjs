import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluateOpportunity,
  opportunityTotals,
} from "../shared/opportunities.ts";
import { probeActivity } from "../server/opportunity-advice.mjs";
const now = Date.parse("2026-10-25T12:00:00Z"),
  old = now - 100 * 86400000;
const target = (id, p = "C:\\repos\\app\\node_modules") => ({
  id,
  path: p,
  category: "dependencies",
  kind: "generated",
  cleanupSupported: true,
  label: "Installed Node packages",
  restore: "npm ci",
});
const rules = {
  recipe: "old-dependencies",
  olderDays: 30,
  minimumBytes: 100,
  now,
};
const measured = {
  path: "",
  measuredAt: new Date(now).toISOString(),
  status: "complete",
  basis: "allocated",
  logicalBytes: 1000,
  allocatedBytes: 800,
  exclusiveAllocatedBytes: 400,
  sharedAllocatedBytes: 400,
  fileCount: 10,
  newestActivityAt: old,
  skippedCount: 0,
  errorCount: 0,
  notices: [],
};
test("cleanup receipts invalidate older overlapping measurements and recorded estimates", () => {
  const evidence = {
    measurement: {
      ...measured,
      measuredAt: new Date(now - 1000).toISOString(),
    },
    recorded: {
      logicalBytes: 1000,
      exclusiveLogicalBytes: 1000,
      newestWriteAt: old,
      coverageComplete: true,
      recordedAt: new Date(now - 2000).toISOString(),
    },
    changes: [{ path: "C:\\repos\\app", changedAt: now - 500 }],
  };
  let item = evaluateOpportunity(target("a"), evidence, rules);
  assert.equal(item.fresh, false);
  assert.equal(item.confirmed, false);
  assert.equal(item.gainBytes, null);
  item = evaluateOpportunity(
    target("a"),
    { ...evidence, measurement: measured },
    rules,
  );
  assert.equal(item.confirmed, true);
  assert.equal(item.gainBytes, 400);
  item = evaluateOpportunity(
    target("a"),
    { ...evidence, changes: [{ path: "C:\\repos\\app2", changedAt: now }] },
    rules,
  );
  assert.equal(item.confirmed, true);
});
test("old package dates never override a recent installation hint", () => {
  const item = evaluateOpportunity(
    target("a"),
    {
      recorded: {
        logicalBytes: 1000,
        exclusiveLogicalBytes: 1000,
        newestWriteAt: old,
        coverageComplete: true,
      },
      activity: {
        latestAt: now - 86400000,
        checkedAt: new Date(now).toISOString(),
        evidence: ["recent install marker"],
      },
    },
    rules,
  );
  assert.equal(item.ageState, "recent");
  assert.equal(item.visible, false);
  assert.equal(item.confirmed, false);
});
test("only complete fresh metadata confirms age and physical gain excludes shared data", () => {
  const item = evaluateOpportunity(
    target("a"),
    { measurement: measured },
    rules,
  );
  assert.equal(item.ageState, "confirmed-old");
  assert.equal(item.confirmed, true);
  assert.equal(item.gainBytes, 400);
  assert.equal(item.gainBasis, "allocated");
  const partial = evaluateOpportunity(
    target("b"),
    { measurement: { ...measured, status: "partial" } },
    rules,
  );
  assert.equal(partial.confirmed, false);
  assert.notEqual(partial.ageState, "confirmed-old");
  const stale = evaluateOpportunity(
    target("c"),
    { measurement: { ...measured, measuredAt: new Date(old).toISOString() } },
    rules,
  );
  assert.equal(stale.confirmed, false);
});
test("unknown and partial estimates remain visible for verification without inflating totals", () => {
  const unknown = evaluateOpportunity(target("a"), {}, rules);
  assert.equal(unknown.visible, true);
  assert.equal(unknown.gainBytes, null);
  const partial = evaluateOpportunity(
    target("b", "C:\\repos\\other\\node_modules"),
    {
      recorded: {
        logicalBytes: 10,
        exclusiveLogicalBytes: 10,
        newestWriteAt: old,
        coverageComplete: false,
      },
    },
    rules,
  );
  assert.equal(partial.visible, true);
  assert.equal(partial.confirmed, false);
  const totals = opportunityTotals([unknown, partial]);
  assert.equal(totals.measuredGainBytes, 0);
  assert.equal(totals.recordedLogicalBytes, 10);
  assert.equal(totals.unmeasuredCount, 1);
});
test("parent and child selections count once and logical estimates never masquerade as measured allocation", () => {
  const parent = evaluateOpportunity(
    target("a", "C:\\repos\\app"),
    { measurement: measured },
    { ...rules, recipe: "largest" },
  );
  const child = evaluateOpportunity(
    target("b", "C:\\repos\\app\\node_modules"),
    { measurement: measured },
    { ...rules, recipe: "largest" },
  );
  assert.equal(opportunityTotals([parent, child]).measuredGainBytes, 400);
  const recorded = evaluateOpportunity(
    target("c", "C:\\repos\\other\\node_modules"),
    {
      recorded: {
        logicalBytes: 2000,
        exclusiveLogicalBytes: 1500,
        newestWriteAt: old,
        coverageComplete: true,
      },
    },
    rules,
  );
  assert.equal(recorded.gainBasis, "recorded-logical");
  assert.equal(recorded.confirmed, false);
  assert.equal(
    opportunityTotals([parent, recorded]).recordedLogicalBytes,
    1500,
  );
});
test("live folder/install probes identify hints without claiming generation or last-use dates", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reclaim-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, "node_modules");
  await mkdir(modules);
  await writeFile(path.join(modules, ".package-lock.json"), "{}");
  await utimes(
    path.join(modules, ".package-lock.json"),
    new Date("2020-01-01"),
    new Date("2020-01-01"),
  );
  const result = await probeActivity({
    path: modules,
    category: "dependencies",
  });
  assert(result.latestAt > Date.parse("2025-01-01"));
  assert(
    result.evidence.some((x) => /creation|created|metadata|folder/i.test(x)),
  );
  assert.equal(result.complete, false);
});
test("newer scan or live activity evidence invalidates a previously old measurement", () => {
  const prior = {
    ...measured,
    measuredAt: new Date(now - 5 * 60000).toISOString(),
  };
  const newer = {
    logicalBytes: 1000,
    exclusiveLogicalBytes: 1000,
    fileCount: 10,
    newestWriteAt: now - 2 * 60000,
    coverageComplete: true,
    recordedAt: new Date(now - 60000).toISOString(),
  };
  const changed = evaluateOpportunity(
    target("newer"),
    { measurement: prior, recorded: newer },
    rules,
  );
  assert.equal(changed.fresh, false);
  assert.equal(changed.ageState, "recent");
  assert.equal(changed.confirmed, false);
  assert.equal(opportunityTotals([changed]).measuredGainBytes, 0);
  const marker = evaluateOpportunity(
    target("marker"),
    {
      measurement: prior,
      activity: {
        latestAt: now - 60000,
        checkedAt: new Date(now).toISOString(),
        evidence: ["new activity"],
      },
    },
    { ...rules, recipe: "largest" },
  );
  assert.equal(marker.fresh, false);
  assert.equal(marker.confirmed, false);
  assert.equal(opportunityTotals([marker]).measuredGainBytes, 0);
});
test("newer shared-link evidence cannot retain a positive exclusive allocation estimate", () => {
  const prior = {
    ...measured,
    fileCount: 2,
    measuredAt: new Date(now - 5 * 60000).toISOString(),
  };
  const recorded = {
    logicalBytes: 1000,
    exclusiveLogicalBytes: 0,
    sharedLogicalBytes: 1000,
    fileCount: 2,
    newestWriteAt: old,
    coverageComplete: true,
    recordedAt: new Date(now - 60000).toISOString(),
  };
  const result = evaluateOpportunity(
    target("links"),
    { measurement: prior, recorded },
    { ...rules, recipe: "largest", minimumBytes: 0 },
  );
  assert.equal(result.fresh, false);
  assert.equal(result.confirmed, false);
  assert.equal(opportunityTotals([result]).measuredGainBytes, 0);
});
test("cancelled measurements preserve saved estimates and protected targets do not count as productive gain", () => {
  const recorded = {
    logicalBytes: 1000,
    exclusiveLogicalBytes: 1000,
    newestWriteAt: old,
    coverageComplete: true,
    recordedAt: new Date(old).toISOString(),
  };
  const cancelled = {
    ...measured,
    status: "cancelled",
    basis: "logical-only",
    logicalBytes: 0,
    allocatedBytes: null,
    exclusiveAllocatedBytes: null,
    sharedAllocatedBytes: null,
    fileCount: 0,
    newestActivityAt: null,
  };
  const item = evaluateOpportunity(
    target("cancelled"),
    { recorded, measurement: cancelled },
    rules,
  );
  assert.equal(item.gainBytes, 1000);
  assert.equal(item.gainBasis, "recorded-logical");
  assert.equal(item.confirmed, false);
  assert.equal(opportunityTotals([item]).recordedLogicalBytes, 1000);
  const cancelledProgress = evaluateOpportunity(
    target("cancelled-progress"),
    {
      recorded,
      measurement: {
        ...measured,
        status: "cancelled",
        exclusiveAllocatedBytes: 20,
      },
    },
    rules,
  );
  assert.equal(cancelledProgress.gainBasis, "recorded-logical");
  assert.equal(cancelledProgress.gainBytes, 1000);
  const protectedTarget = {
    ...target("protected"),
    cleanupSupported: false,
    blockedReason: "Protected application path",
  };
  const protectedItem = evaluateOpportunity(
    protectedTarget,
    { measurement: measured },
    { ...rules, recipe: "all" },
  );
  assert.equal(opportunityTotals([protectedItem]).measuredGainBytes, 0);
});
