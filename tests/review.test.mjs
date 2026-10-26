import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReview,
  dispositionReview,
  reviewStatus,
} from "../shared/review.ts";

test("old scan review records gain a resolved list without losing selections", () => {
  assert.deepEqual(normalizeReview({ selected: ["a"], ignored: ["b"] }), {
    selected: ["a"],
    ignored: ["b"],
    resolved: [],
  });
});
test("bulk resolving removes items from review and dismissals while preserving unrelated items", () => {
  const before = {
    selected: ["a", "b", "other"],
    ignored: ["c"],
    resolved: ["done"],
  };
  const after = dispositionReview(before, ["a", "b", "c"], "resolve");
  assert.deepEqual(after, {
    selected: ["other"],
    ignored: [],
    resolved: ["done", "a", "b", "c"],
  });
  assert.deepEqual(before.selected, ["a", "b", "other"]);
  assert.equal(reviewStatus(after, "a"), "resolved");
});
test("reopening, dismissing and returning to review keep dispositions exclusive", () => {
  const before = { selected: [], ignored: [], resolved: ["a", "b"] };
  const reopened = dispositionReview(before, ["a"], "reopen");
  assert.equal(reviewStatus(reopened, "a"), "open");
  const queued = dispositionReview(reopened, ["b"], "review");
  assert.equal(reviewStatus(queued, "b"), "review");
  assert.deepEqual(queued.resolved, []);
  const dismissed = dispositionReview(queued, ["b"], "dismiss");
  assert.equal(reviewStatus(dismissed, "b"), "dismissed");
  assert.deepEqual(dismissed.selected, []);
});
