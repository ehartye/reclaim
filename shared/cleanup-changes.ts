const normalized = (p: string) =>
  p
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
export function latestChange(
  target: string,
  changes: { path: string; changedAt: number }[],
) {
  const p = normalized(target);
  return changes.reduce((latest, change) => {
    const other = normalized(change.path);
    return p === other || p.startsWith(other + "/") || other.startsWith(p + "/")
      ? Math.max(latest, change.changedAt || 0)
      : latest;
  }, 0);
}
