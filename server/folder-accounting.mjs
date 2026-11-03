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
