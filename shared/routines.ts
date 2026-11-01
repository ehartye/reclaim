export type RoutineMode = "in-app" | "guided" | "review-only";
export type RoutineDefinition = {
  id: string;
  policyVersion: number;
  label: string;
  mode: RoutineMode;
  scope: "project" | "cache" | "managed-store";
  recoveryCost: "low" | "medium" | "high";
  description: string;
  boundary: string;
  evidence: string[];
  requiresGuideQualification: boolean;
  supportsAgeHint: boolean;
  defaults: { minimumBytes: number; minimumAgeDays: number | null };
};
export type RoutinePreset = {
  routineId: string;
  policyVersion: number;
  minimumBytes: number;
  minimumAgeDays: number | null;
  roots: string[];
};
export type RoutinePresetState = {
  schemaVersion: 1;
  presets: Record<string, RoutinePreset>;
  invalidPresets: Record<
    string,
    { parameters: Record<string, unknown>; error: string }
  >;
};
export type RoutineCandidate = {
  id: string;
  path: string;
  mode: RoutineMode;
  kind?: "generated" | "worktree";
  cleanupSupported: boolean;
  label?: string;
  blockedReason?: string;
  reason: string;
  restore?: string;
  logicalBytes: number | null;
  estimated: boolean;
  complete: boolean;
  recordedAt?: string;
  newestActivityAt?: number | null;
  ageState?: "off" | "unknown" | "possible-old" | "confirmed-old" | "recent";
};
export type RoutineRun = {
  id: string;
  routineId: string;
  policyVersion: number;
  parameters: RoutinePreset;
  scanId?: string;
  checkedAt: string;
  candidates: RoutineCandidate[];
  coverage: {
    complete: boolean;
    candidateCount: number;
    checkedDirectories: number;
    errors: { path: string; reason: string }[];
  };
  notices: string[];
};
export const ROUTINE_DEFAULT_MINIMUM_BYTES = 500_000_000;
export const ROUTINE_MAXIMUM_BYTES = 1024 ** 5;
export function routineSizeMatches(
  bytes: number | null | undefined,
  minimumBytes: number,
) {
  return (
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    Number.isSafeInteger(minimumBytes) &&
    minimumBytes >= 0 &&
    minimumBytes <= ROUTINE_MAXIMUM_BYTES &&
    bytes > minimumBytes
  );
}
