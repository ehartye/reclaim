import { test } from "node:test";
import assert from "node:assert/strict";
import { routineDefinitions } from "../server/routine-policies.mjs";
import {
  routineCopies,
  routineCopy,
  presentRoutine,
  presentRoutineCandidate,
} from "../src/routine-presentation.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const definition = (id = "generated-output") =>
  routineDefinitions.find((item) => item.id === id);
const preset = (id = "generated-output") => ({
  routineId: id,
  policyVersion: 1,
  minimumBytes: 500_000_000,
  minimumAgeDays: null,
  roots: [],
});
const candidate = (extra = {}) => ({
  id: "candidate-1",
  path: "C:/fixture/project/dist",
  mode: "in-app",
  cleanupSupported: true,
  reason: "Server-established project output.",
  logicalBytes: 600_000_000,
  estimated: false,
  complete: true,
  ...extra,
});
function row({
  id = "generated-output",
  candidates = [candidate()],
  ...extra
} = {}) {
  return {
    definition: definition(id),
    preset: preset(id),
    status: "successful",
    receivedAt: NOW,
    preparationDeadline: NOW + 300_000,
    run: {
      id: "run-1",
      routineId: id,
      policyVersion: 1,
      parameters: preset(id),
      checkedAt: new Date(NOW).toISOString(),
      candidates,
      coverage: {
        complete: true,
        candidateCount: candidates.length,
        checkedDirectories: candidates.length,
        errors: [],
      },
      notices: [],
    },
    ...extra,
  };
}
const present = (value = row(), interaction = {}) =>
  presentRoutine(value, { now: NOW, ...interaction });
const guide = (qualified = true, extra = {}) => ({
  title: "Owner instructions",
  mode: qualified ? "guided" : "review-only",
  qualified,
  steps: ["Review the exact scope."],
  commands: [],
  notices: [],
  evidence: [],
  ...extra,
});

test("all fourteen catalog IDs have deliberate concise copy, independent of recovery cost", () => {
  assert.equal(routineDefinitions.length, 14);
  assert.deepEqual(
    Object.keys(routineCopies).sort(),
    routineDefinitions.map((item) => item.id).sort(),
  );
  for (const item of routineDefinitions) {
    const copy = routineCopy(item.id);
    assert.ok(copy.explanation.trim().split(/\s+/).length <= 12, item.id);
    assert.ok(copy.risk.trim().split(/\s+/).length <= 20, item.id);
    const low = present(
      row({ id: item.id, definition: { ...item, recoveryCost: "low" } }),
    );
    const high = present(
      row({ id: item.id, definition: { ...item, recoveryCost: "high" } }),
    );
    assert.deepEqual(low, high);
    assert.equal("safetyRating" in low, false);
  }
});

test("unknown IDs conservatively inspect even when candidate fields claim cleanup", () => {
  const value = row({
    definition: { ...definition(), id: "future-routine", mode: "in-app" },
  });
  const result = present(value);
  assert.equal(result.action.kind, "inspect");
  assert.equal(result.canPrepare, false);
  assert.equal(result.counts.reviewOnly, 1);
  assert.match(result.risk, /unverified/);
  assert.deepEqual(routineCopy("constructor"), routineCopy("future-routine"));
});

test("invalid settings precede check failures, expiry and cleanup availability", () => {
  const reason =
    "Saved root contains a disallowed path. Preserve its entire server reason.";
  const value = row({
    status: "failed",
    error: "Check failed",
    preparationDeadline: NOW - 1,
  });
  assert.deepEqual(
    present(value, { invalidPreset: { error: reason } }).action,
    {
      kind: "fix-settings",
      label: "Fix settings",
      reason,
      disabled: false,
    },
  );
  assert.equal(
    present(row({ status: "needs-settings", error: reason })).action.reason,
    reason,
  );
  assert.equal(
    present(row(), { draftValid: false }).action.kind,
    "fix-settings",
  );
  assert.equal(present(row(), { draftValid: false }).canCheckDraft, false);
});

test("failed, unrun, queued and stopped checks use explicit single checks", () => {
  const reason = "The server could not inspect this exact folder.";
  const failed = present(row({ status: "failed", error: reason }));
  assert.equal(failed.action.kind, "retry");
  assert.equal(failed.action.label, "Try again");
  assert.equal(failed.action.reason, reason);
  for (const status of ["not-run", "queued"]) {
    const result = present(row({ status, run: undefined }));
    assert.equal(result.action.kind, "check");
    assert.equal(result.action.label, "Check routine");
  }
});

test("mixed candidates retain individual restrictions and only server-eligible review counts", () => {
  const blocker =
    "This is a running tool runtime. Removing it could interrupt active tools and lose session data; inspect consumers first.";
  const value = row({
    candidates: [
      candidate(),
      candidate({ id: "blocked", blockedReason: blocker }),
      candidate({
        id: "unsupported",
        cleanupSupported: false,
        reason: "Evidence does not establish generated output.",
      }),
      candidate({ id: "review", mode: "review-only" }),
    ],
  });
  const result = present(value);
  assert.equal(result.action.kind, "review-folders");
  assert.deepEqual(result.counts, {
    eligibleForReview: 1,
    qualifiedGuidance: 0,
    reviewOnly: 3,
  });
  assert.ok(result.restrictions.includes(blocker));
  assert.equal(
    presentRoutineCandidate(value.definition, value.run.candidates[1]).label,
    "Review only",
  );
  assert.equal(
    presentRoutineCandidate(
      { ...definition(), mode: "review-only" },
      candidate(),
    ).eligibleForReview,
    false,
  );
  assert.equal(
    presentRoutineCandidate({ ...definition(), mode: "guided" }, candidate())
      .eligibleForReview,
    false,
  );
});

test("qualified guidance can provide owner or OS UI instructions without copyable commands", () => {
  const value = row({
    id: "npm-cache",
    candidates: [
      candidate({
        mode: "guided",
        cleanupSupported: false,
        guide: guide(),
      }),
    ],
  });
  assert.equal(present(value).action.kind, "view-guidance");
  assert.deepEqual(value.run.candidates[0].guide.commands, []);
  assert.deepEqual(present(value).counts, {
    eligibleForReview: 0,
    qualifiedGuidance: 1,
    reviewOnly: 0,
  });
  const variations = [
    { guide: guide(false, { commands: [{ command: "unexpected text" }] }) },
    { guide: guide(true, { mode: "review-only" }) },
    { mode: "review-only" },
    { blockedReason: "Installed version is not qualified." },
  ];
  for (const extra of variations) {
    value.run.candidates[0] = candidate({
      mode: "guided",
      cleanupSupported: false,
      guide: guide(),
      ...extra,
    });
    const result = present(value);
    assert.equal(result.action.kind, "read-guidance");
    assert.equal(result.counts.qualifiedGuidance, 0);
    assert.equal(result.canPrepare, false);
  }
});

test("DDC and Zen never gain in-app cleanup from favorable candidate flags", () => {
  for (const id of ["unreal-ddc", "unreal-zen"]) {
    const value = row({ id, candidates: [candidate({ guide: guide() })] });
    assert.equal(present(value).action.kind, "read-guidance");
    assert.equal(present(value).counts.eligibleForReview, 0);
    assert.equal(present(value).canPrepare, false);
  }
});

test("all-blocked results use documentation where provided and inspection otherwise", () => {
  const value = row({
    candidates: [candidate({ blockedReason: "Retain this folder." })],
  });
  assert.equal(present(value).action.kind, "read-guidance");
  value.definition = { ...value.definition, evidence: [] };
  assert.equal(present(value).action.kind, "inspect");
});

test("empty results open filters rather than imply zero opportunity", () => {
  const result = present(row({ candidates: [] }));
  assert.equal(result.action.kind, "review-filters");
  assert.equal(result.action.reason, "No matches under saved filters.");
  assert.equal(result.canPrepare, false);
  assert.equal(
    present(row({ candidates: [], preparationDeadline: NOW })).action.kind,
    "check-again",
    "expired evidence precedes the empty-result action",
  );
});

test("original proof deadline independently expires and missing or malformed proof requires a new check", () => {
  for (const preparationDeadline of [
    undefined,
    null,
    NaN,
    Infinity,
    NOW,
    NOW - 1,
  ]) {
    const result = present(row({ preparationDeadline }));
    assert.equal(result.action.kind, "check-again");
    assert.equal(result.fresh, false);
    assert.equal(result.canPrepare, false);
  }
  const value = row();
  assert.equal(
    present(value, { now: NOW + 299_999 }).action.kind,
    "review-folders",
  );
  assert.equal(
    present(value, { now: NOW + 300_000 }).action.kind,
    "check-again",
  );
  value.run.checkedAt = "2026-02-30T12:00:00Z";
  assert.equal(present(value).action.kind, "check-again");
  value.run.checkedAt = "not a date";
  assert.equal(present(value).action.kind, "check-again");
});

test("saved or draft evidence changes require rerunning without renewing the original deadline", () => {
  const value = row();
  value.preset = { ...value.preset, minimumBytes: 900_000_000 };
  assert.equal(present(value).action.kind, "check-again");
  assert.equal(present(value).canPrepare, false);
  assert.equal(
    present(row(), { evidenceChanged: true }).action.kind,
    "check-again",
  );
});

test("busy permits browsing but disables checks, saves and preparation", () => {
  const browse = present(row(), { busy: true });
  assert.equal(browse.action.kind, "review-folders");
  assert.equal(browse.action.disabled, false);
  assert.equal(browse.canSwitch, true);
  for (const key of ["canSave", "canCheckDraft", "canPrepare", "canRunAll"])
    assert.equal(browse[key], false);
  const pending = present(row({ status: "running", run: undefined }));
  assert.equal(pending.action.disabled, true);
  assert.match(pending.action.reason, /progress/);
  const failed = present(
    row({ status: "failed", error: "Exact server failure." }),
    { busy: true },
  );
  assert.match(failed.action.reason, /Exact server failure\./);
});

test("dirty settings block compact checks, switching, batch and preparation while preserving the explicit draft check", () => {
  const value = row();
  const before = structuredClone(value);
  const result = present(value, { dirty: true });
  assert.equal(result.action.disabled, false);
  assert.equal(result.canSwitch, false);
  assert.equal(result.canRunAll, false);
  assert.equal(result.canPrepare, false);
  assert.equal(result.canSave, true);
  assert.equal(result.canCheckDraft, true);
  assert.match(result.availabilityReason, /repeat your action/);
  const unrun = present(row({ run: undefined }), { dirty: true });
  assert.equal(unrun.action.disabled, true);
  assert.match(unrun.action.reason, /Unsaved changes/);
  assert.deepEqual(value, before, "presentation never mutates evidence");
});
