export type FileEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  nlink?: number;
};
export type Finding = {
  insight?: { reason: string; restore: string; projectPath?: string };
  id: string;
  category: string;
  title: string;
  path: string;
  bytes: number;
  filePaths: string[];
  fileCount: number;
  risk: "low" | "review";
  reason: string;
  impact: string;
  action: string;
  evidence: string[];
  confidence: string;
  score: number;
  modifiedAt: number;
};
export type Directory = {
  path: string;
  bytes: number;
  fileCount: number;
  complete?: boolean;
  estimated?: boolean;
  measuredAt?: string;
  hasGitFile?: boolean;
};
export type FolderInspection = {
  path: string;
  files: FileEntry[];
  nextOffset: number | null;
  notices: string[];
};
export type IgnoredFolderResult = {
  scanId: string;
  recordedAt: string;
  checkedAt: string;
  minimumBytes: number;
  targets: (Directory & {
    repository: string;
    ignore: { source: string; line: number; pattern: string };
    cleanupSupported: boolean;
    reason: string;
  })[];
  coverage: {
    complete: boolean;
    candidateCount: number;
    checkedDirectories: number;
    repositories: number;
    directoryLimit: number;
  };
  errors: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  notices: string[];
};
export type Scan = {
  folderSizing?: {
    minimumBytes: number;
    basis: "logical-file-entries";
    scopeComplete: boolean;
    matchingCount: number;
    estimated?: boolean;
    cachedBranchCount?: number;
    prunedDirectoryCount?: number;
    visitedDirectoryCount?: number;
    freshFileCount?: number;
    cacheDate?: string;
  };
  id: string;
  root: string;
  name: string;
  status: string;
  startedAt: string;
  completedAt: string;
  totalBytes: number;
  opportunityBytes: number;
  fileCount: number;
  directoryCount: number;
  durationMs: number;
  findings: Finding[];
  files: FileEntry[];
  directories: Directory[];
  duplicateGroups: {
    id: string;
    hash: string;
    files: FileEntry[];
    bytes: number;
  }[];
  skipped: { path: string; reason: string }[];
  errors: { path: string; reason: string }[];
  notices: string[];
  disk?: { total: number; free: number };
  options: Settings & {
    operation?: string;
    folderMinBytes?: number;
    folderScanMode?: "quick" | "fresh";
  };
};
export type ScanSummary = Pick<
  Scan,
  | "id"
  | "root"
  | "name"
  | "status"
  | "startedAt"
  | "completedAt"
  | "totalBytes"
  | "opportunityBytes"
  | "fileCount"
  | "durationMs"
> & { findingCount: number; coverageKey?: string; operation?: string };
export type Settings = {
  opportunityAgeDays: number;
  opportunityMinBytes: number;
  developmentRoots: string[];
  minimumBytes: number;
  largeFileBytes: number;
  staleDays: number;
  duplicates: boolean;
  duplicateMinBytes: number;
  hashBudgetBytes: number;
  maxFiles: number;
  exclusions: string[];
  skipCloud: boolean;
};
export type { Review } from "../shared/review.ts";
import type { Review } from "../shared/review.ts";
export type State = {
  measurementJob?: MeasurementJob | null;
  cleanupBusy: boolean;
  cleanups: CleanupRecord[];
  token: string;
  settings: Settings;
  scans: ScanSummary[];
  reviews: Record<string, Review>;
  locations: { label: string; path: string }[];
  job: {
    id: string;
    root: string;
    progress: {
      phase: string;
      current: string;
      fileCount: number;
      totalBytes: number;
    };
  } | null;
  lastError?: string;
};
export type DevelopmentTarget = {
  recorded?: import("../shared/opportunities.ts").RecordedOpportunity;
  blockedReason?: string;
  activity?: import("../shared/opportunities.ts").ActivityHint;
  category: "builds" | "dependencies" | "caches" | "worktrees";
  cleanupSupported: boolean;
  id: string;
  path: string;
  kind: "generated" | "worktree";
  label: string;
  projectPath: string;
  restore: string;
  reason: string;
  branch?: string;
  lastCommitAt?: string;
  locked?: boolean;
};
export type MeasurementJob = {
  id: string;
  total: number;
  done: number;
  path: string;
  progress: { fileCount?: number; logicalBytes?: number } | null;
};
export type IntelligenceSnapshot = {
  changes?: { path: string; changedAt: number }[];
  index: {
    status: string;
    progress: { done: number; total: number; current?: string };
    records: Record<
      string,
      import("../shared/opportunities.ts").RecordedOpportunity
    >;
    error?: string;
  };
  measurements: Record<
    string,
    import("../shared/opportunities.ts").FolderMeasurement
  >;
  measurementJob: MeasurementJob | null;
  measurementError?: string;
};
export type DevelopmentInventory = {
  source?: "saved";
  roots: string[];
  operation: string;
  coverage: {
    directoriesVisited: number;
    skippedSubtrees: number;
    complete: boolean;
    directoryLimit: number;
  };
  targets: DevelopmentTarget[];
  projects: { path: string }[];
  notices: string[];
};
export type CleanupPreview = {
  id: string;
  path: string;
  kind: string;
  phrase: string;
  expiresAt: number;
  bytes: number;
  fileCount: number;
  restore: string;
  reason: string;
  warnings: string[];
};
export type CleanupRecord = {
  scanId?: string;
  findingId?: string;
  id: string;
  path: string;
  kind: string;
  status: "started" | "deleted" | "failed" | "partial";
  deletedBytes: number;
  deletedFiles: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
};
export const categories: Record<string, { label: string; color: string }> = {
  dependencies: { label: "Dependencies", color: "#4678de" },
  builds: { label: "Build output", color: "#739bea" },
  caches: { label: "Caches", color: "#279b94" },
  duplicates: { label: "Duplicates", color: "#8b78bc" },
  installers: { label: "Installers & archives", color: "#d8a155" },
  large: { label: "Large & older", color: "#a5b3c5" },
};
export const bytes = (n: number) => {
  if (!n) return "0 B";
  const u = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** u).toLocaleString(undefined, { maximumFractionDigits: u ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][u]}`;
};
export const basename = (p: string) =>
  p.split(/[\\/]/).filter(Boolean).at(-1) || p;
export function parent(p: string) {
  if (p === "/" || /^[a-z]:[\\/]$/i.test(p)) return p;
  const clean = p.replace(/[\\/]+$/, "");
  const index = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return index === 0
    ? clean.slice(0, 1)
    : index === 2 && /^[a-z]:/i.test(clean)
      ? clean.slice(0, 3)
      : index < 0
        ? clean
        : clean.slice(0, index);
}
export function scanDelta(
  current: Pick<ScanSummary, "status" | "totalBytes" | "coverageKey">,
  previous: Pick<ScanSummary, "status" | "totalBytes" | "coverageKey">,
) {
  return current.status === "completed" &&
    previous.status === "completed" &&
    current.coverageKey &&
    current.coverageKey === previous.coverageKey
    ? current.totalBytes - previous.totalBytes
    : null;
}
export const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export const queueBytes = (s: Scan, ids: string[]) => {
  const wanted = new Set(ids);
  const paths = new Set(
    s.findings.filter((f) => wanted.has(f.id)).flatMap((f) => f.filePaths),
  );
  return s.files.reduce((n, f) => n + (paths.has(f.path) ? f.size : 0), 0);
};
export function categorySizes(
  s: Pick<Scan, "files">,
  findings: Pick<Finding, "category" | "filePaths">[],
) {
  const owner = new Map<string, string>();
  for (const f of findings)
    for (const p of f.filePaths) if (!owner.has(p)) owner.set(p, f.category);
  const sizes: Record<string, number> = {};
  for (const f of s.files) {
    const category = owner.get(f.path);
    if (category) sizes[category] = (sizes[category] || 0) + f.size;
  }
  return sizes;
}
