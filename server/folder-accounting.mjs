import path from "node:path";

export function rollupFolderRows(dirs, issues, startedAt) {
  const children = new Map();
  for (const d of dirs.values()) {
    const parent = path.dirname(d.path);
    if (parent !== d.path)
      children.set(parent, (children.get(parent) || 0) + 1);
  }
  for (const issue of issues) {
    const d = dirs.get(issue) || dirs.get(path.dirname(issue));
    if (d) d.complete = false;
  }
  for (const d of dirs.values())
    if (!d.estimated && (children.get(d.path) || 0) !== d.childCount)
      d.complete = false;
  let incomplete = false;
  for (const d of [...dirs.values()].reverse()) {
    d.directoryCount = d.cachedDirectories || d.directoryCount || 1;
    if (!d.complete) incomplete = true;
    const parent = dirs.get(path.dirname(d.path));
    if (parent && parent !== d) {
      parent.bytes += d.bytes;
      parent.fileCount += d.fileCount;
      parent.complete = parent.complete && d.complete;
      parent.estimated = Boolean(parent.estimated || d.estimated);
      if (d.estimated)
        parent.measuredAt = new Date(
          Math.min(
            Date.parse(parent.measuredAt || startedAt),
            Date.parse(d.measuredAt || startedAt),
          ),
        ).toISOString();
      parent.directoryCount = (parent.directoryCount || 1) + d.directoryCount;
    }
  }
  return incomplete;
}

// Correct only the identified legacy drive-root self-rollup in the read model.
// Raw scan evidence remains unchanged on disk.
export function normalizeFolderReport(report) {
  if (
    !report.folderSizing ||
    (report.folderSizing.accountingVersion || 0) >= 2 ||
    path.dirname(report.root) !== report.root
  )
    return report;
  const root = report.directories?.find((d) => d.path === report.root);
  if (
    !root ||
    root.bytes !== report.totalBytes * 2 ||
    root.fileCount !== report.fileCount * 2
  )
    return report;
  root.bytes = report.totalBytes;
  root.fileCount = report.fileCount;
  if (
    Number.isSafeInteger(root.directoryCount) &&
    root.directoryCount % 2 === 0
  )
    root.directoryCount /= 2;
  report.folderSizing = {
    ...report.folderSizing,
    accountingVersion: 2,
    rootAccountingCorrected: true,
    matchingCount: report.directories.filter(
      (d) => d.bytes > report.folderSizing.minimumBytes,
    ).length,
  };
  report.notices = [
    ...(report.notices || []),
    "The filesystem-root row was corrected to remove a legacy self-rollup. Original saved evidence has not been rewritten.",
  ];
  return report;
}
