import type { Scan } from "./types";
const expected = new Map([
  ["Your exclusion", "Excluded by settings"],
  ["Protected system folder", "Protected system folders"],
  ["Cloud folder excluded", "Cloud folders excluded by settings"],
  ["Your exclusion or cloud setting", "Excluded by settings"],
  ["Excluded by your settings", "Excluded by settings"],
  [
    "Link, offline file or cloud placeholder",
    "Links, offline or cloud entries not inspected",
  ],
  ["Excluded or linked entry", "Excluded or linked entries not inspected"],
]);
export function presentScanCoverage(scan: Scan) {
  const groups = new Map<string, { label: string; paths: Scan["skipped"] }>();
  const unresolved: Scan["skipped"] = [];
  for (const entry of scan.skipped) {
    const label = expected.get(entry.reason);
    if (!label) {
      unresolved.push(entry);
      continue;
    }
    const group = groups.get(label) || { label, paths: [] };
    group.paths.push(entry);
    groups.set(label, group);
  }
  const cacheNotices = scan.notices.filter((n) =>
    n.startsWith("Folder cache could not be saved:"),
  );
  const notices = scan.notices.filter(
    (n) =>
      !cacheNotices.includes(n) &&
      !n.startsWith("Coverage is incomplete; folder totals are lower bounds"),
  );
  const issueCount = scan.errors.length + unresolved.length;
  const truncated = scan.skipped.length >= 1000 || scan.errors.length >= 1000;
  const label =
    scan.status === "cancelled"
      ? "Stopped"
      : scan.status === "failed"
        ? "Failed"
        : issueCount
          ? "Review scan issues"
          : scan.status === "completed"
            ? "Finished"
            : scan.status === "partial"
              ? "Results available"
              : "Status unknown";
  const summary =
    scan.status === "cancelled"
      ? "Scan stopped before finishing. Results cover only the entries counted."
      : scan.status === "failed"
        ? "The scan failed. Review the recorded problems before using these results."
        : issueCount
          ? `${issueCount.toLocaleString()} recorded scan issue${issueCount === 1 ? " needs" : "s need"} attention. Exclusions and protections are listed separately.`
          : scan.status === "completed"
            ? "The scan finished within its recorded scope."
            : "Results are available with omissions or estimates. This saved report does not establish complete coverage.";
  return {
    label,
    summary,
    groups: [...groups.values()],
    unresolved,
    cacheNotices,
    notices,
    issueCount,
    truncated,
    sizeExplanation: scan.folderSizing?.estimated
      ? "Some sizes reuse dated cache measurements. Mixed totals are estimates and may be higher or lower than current sizes."
      : scan.folderSizing &&
          (scan.status !== "completed" ||
            !scan.folderSizing.scopeComplete ||
            scan.skipped.length > 0 ||
            issueCount > 0)
        ? "Folder totals count only inspected entries. Excluded or unreadable contents are not included, so full-folder sizes remain lower bounds."
        : "Sizes describe the recorded scan, not current free space or guaranteed deletion savings.",
    showBanner:
      scan.status !== "completed" || issueCount > 0 || cacheNotices.length > 0,
  };
}
