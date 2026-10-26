export type Review = {
  selected: string[];
  ignored: string[];
  resolved: string[];
};
export type DispositionAction =
  "resolve" | "reopen" | "dismiss" | "review" | "removeReview";
export function normalizeReview(value?: Partial<Review> | null): Review {
  const list = (items: unknown): string[] =>
    Array.isArray(items)
      ? [...new Set(items.filter((id): id is string => typeof id === "string"))]
      : [];
  const resolved = list(value?.resolved),
    done = new Set(resolved);
  const ignored = list(value?.ignored).filter((id) => !done.has(id)),
    hidden = new Set(ignored);
  return {
    selected: list(value?.selected).filter(
      (id) => !done.has(id) && !hidden.has(id),
    ),
    ignored,
    resolved,
  };
}
export function dispositionReview(
  value: Review,
  ids: string[],
  action: DispositionAction,
): Review {
  const before = normalizeReview(value),
    targets = new Set(ids);
  if (action === "removeReview")
    return {
      ...before,
      selected: before.selected.filter((id) => !targets.has(id)),
    };
  const next = {
    selected: before.selected.filter((id) => !targets.has(id)),
    ignored: before.ignored.filter((id) => !targets.has(id)),
    resolved: before.resolved.filter((id) => !targets.has(id)),
  };
  const key =
    action === "resolve"
      ? "resolved"
      : action === "dismiss"
        ? "ignored"
        : action === "review"
          ? "selected"
          : null;
  if (key) next[key].push(...targets);
  return next;
}
export function reviewStatus(
  review: Review,
  id: string,
): "open" | "review" | "resolved" | "dismissed" {
  return review.resolved.includes(id)
    ? "resolved"
    : review.ignored.includes(id)
      ? "dismissed"
      : review.selected.includes(id)
        ? "review"
        : "open";
}
