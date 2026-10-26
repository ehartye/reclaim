import type { Scan, Settings, Finding } from "./types";
const G = 1024 ** 3,
  M = 1024 ** 2;
export const sampleSettings: Settings = {
  opportunityAgeDays: 30,
  opportunityMinBytes: 100 * M,
  developmentRoots: [],
  minimumBytes: M,
  largeFileBytes: 100 * M,
  staleDays: 90,
  duplicates: false,
  duplicateMinBytes: M,
  hashBudgetBytes: G,
  maxFiles: 250000,
  exclusions: [],
  skipCloud: true,
};
const root = "C:\\Workspace";
const rows = [
  [
    "dependencies",
    "Rebuildable dependencies",
    "Projects\\atlas-app\\node_modules",
    5.4,
    "low",
    12482,
  ],
  [
    "caches",
    "Application cache",
    "Projects\\studio-kit\\.cache",
    2.1,
    "low",
    3246,
  ],
  [
    "builds",
    "Generated project output",
    "Projects\\atlas-app\\dist",
    1.6,
    "review",
    418,
  ],
  [
    "duplicates",
    "3 identical copies",
    "Downloads\\brand-assets (2).zip",
    1.2,
    "review",
    2,
  ],
  [
    "installers",
    "Old installer or archive",
    "Downloads\\studio-setup-2024.exe",
    0.85,
    "review",
    1,
  ],
  ["large", "Large, older file", "Videos\\first-cut.mov", 3.2, "review", 1],
  [
    "dependencies",
    "Rebuildable dependencies",
    "Projects\\weekend-site\\node_modules",
    0.65,
    "low",
    6012,
  ],
  [
    "caches",
    "Application cache",
    "Projects\\notebook\\__pycache__",
    0.18,
    "low",
    824,
  ],
] as const;
export const sample: Scan = (() => {
  const files = rows.map((r, i) => ({
    path: root + "\\" + r[2] + (r[5] > 2 ? "\\example-data.bin" : ""),
    size: r[3] * G,
    mtimeMs: Date.now() - 180 * 86400000,
  }));
  const findings: Finding[] = rows.map((r, i) => ({
    id: "sample-" + i,
    category: r[0],
    title: r[1],
    path: root + "\\" + r[2],
    bytes: r[3] * G,
    filePaths: [files[i].path],
    fileCount: r[5],
    risk: r[4],
    reason:
      r[0] === "duplicates"
        ? "Three files have matching complete SHA-256 hashes."
        : r[0] === "dependencies"
          ? "Installed packages can be restored from the project manifest."
          : r[0] === "caches"
            ? "This folder matches a known application cache location."
            : "This is a candidate for your review based on its location, size or modification date.",
    impact:
      r[4] === "low"
        ? "The owning application will need to rebuild or download these files."
        : "Check that these files can be rebuilt, are backed up, or are no longer needed.",
    action:
      r[0] === "dependencies"
        ? "Close the project, inspect the lockfile, then reinstall packages when needed."
        : "Open the containing folder and decide whether to keep, archive or remove it.",
    evidence: [
      r[5].toLocaleString() + " files in this finding",
      "Sample workspace — illustrative data",
    ],
    confidence: r[4] === "low" ? "High" : "Review needed",
    score: 90 - i * 4,
    modifiedAt: files[i].mtimeMs,
  }));
  const directories = [
    { path: root, bytes: 48.6 * G, fileCount: 64328 },
    ...rows
      .filter((r) => r[5] > 2)
      .map((r) => ({
        path: root + "\\" + r[2],
        bytes: r[3] * G,
        fileCount: r[5],
      })),
    { path: root + "\\Projects", bytes: 25.4 * G, fileCount: 58120 },
    { path: root + "\\Downloads", bytes: 8.2 * G, fileCount: 2126 },
    { path: root + "\\Videos", bytes: 10.8 * G, fileCount: 142 },
    { path: root + "\\Documents", bytes: 4.2 * G, fileCount: 3940 },
  ];
  for (const d of directories.filter((d) => d.path.split("\\").length === 3)) {
    const used = files
      .filter((f) => f.path.startsWith(d.path + "\\"))
      .reduce((n, f) => n + f.size, 0);
    files.push({
      path: d.path + "\\Other files",
      size: d.bytes - used,
      mtimeMs: Date.now(),
    });
  }
  return {
    id: "sample",
    root,
    name: "Workspace",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalBytes: 48.6 * G,
    opportunityBytes: rows.reduce((n, r) => n + r[3] * G, 0),
    fileCount: 64328,
    directoryCount: 5218,
    durationMs: 18400,
    files,
    findings,
    directories,
    duplicateGroups: [
      {
        id: "sample-hash",
        hash: "a48c910d3e74f751f6b93ff28c351bc78ec2898ad2f124c3bef5e28462ca330a",
        files: [
          {
            path: root + "\\Documents\\brand-assets.zip",
            size: 0.6 * G,
            mtimeMs: Date.now(),
          },
          ...["", " (2)"].map((s) => ({
            path: root + "\\Downloads\\brand-assets" + s + ".zip",
            size: 0.6 * G,
            mtimeMs: Date.now(),
          })),
        ],
        bytes: 1.2 * G,
      },
    ],
    skipped: [],
    errors: [],
    notices: [],
    disk: { total: 512 * G, free: 86.3 * G },
    options: sampleSettings,
  };
})();
