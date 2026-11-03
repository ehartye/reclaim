export type FileEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  nlink?: number;
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
  folderSizing: {
    accountingVersion: 2;
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
  fileCount: number;
  directoryCount: number;
  durationMs: number;
  directories: Directory[];
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
  | "fileCount"
  | "durationMs"
> & { coverageKey?: string; operation: "folder-sizes" };
export type Settings = {
  developmentRoots: string[];
  exclusions: string[];
  skipCloud: boolean;
  folderMinBytes?: number;
};
export type {
  RoutineDefinition,
  RoutinePreset,
  RoutinePresetState,
} from "../shared/routines.ts";
export type RoutineGuide = {
  title: string;
  mode: import("../shared/routines.ts").RoutineMode;
  qualified: boolean;
  steps: string[];
  commands: {
    label: string;
    command: string;
    scope: string;
    mutates: boolean;
    effects: string;
    optional: boolean;
  }[];
  notices: string[];
  evidence: string[];
};
export type RoutineCandidate =
  import("../shared/routines.ts").RoutineCandidate & { guide?: RoutineGuide };
export type RoutineRun = Omit<
  import("../shared/routines.ts").RoutineRun,
  "candidates"
> & { candidates: RoutineCandidate[] };
export type RoutineCatalog = {
  definitions: import("../shared/routines.ts").RoutineDefinition[];
  presets: Record<string, import("../shared/routines.ts").RoutinePreset>;
  invalidPresets: import("../shared/routines.ts").RoutinePresetState["invalidPresets"];
};
export type State = {
  routines?: import("../shared/routines.ts").RoutinePresetState;
  cleanupBusy: boolean;
  cleanups: CleanupRecord[];
  token: string;
  settings: Settings;
  scans: ScanSummary[];
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
