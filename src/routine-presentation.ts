import type { RoutineBatchRow } from "../shared/routine-batch.ts";
import { preparationDeadline } from "../shared/routine-batch.ts";
import type {
  RoutineCandidate,
  RoutineDefinition,
  RoutinePreset,
  RoutineRun,
} from "./types.ts";

export type RoutineCopy = { explanation: string; risk: string };

// Deliberate product copy, not a source of permissions or safety ratings.
export const routineCopies: Readonly<Record<string, RoutineCopy>> = {
  "generated-output": {
    explanation: "Build outputs and reinstallable project dependencies.",
    risk: "Permanent deletion; later use requires rebuilding or reinstalling.",
  },
  "engine-imports": {
    explanation: "Generated Unity and Godot import caches.",
    risk: "Permanent deletion; reopening projects can trigger a lengthy reimport.",
  },
  "linked-worktrees": {
    explanation: "Additional Git checkouts registered as worktrees.",
    risk: "Local work and unique commits must be preserved; removal requires Git checks.",
  },
  "unreal-ddc": {
    explanation: "Unreal's cached asset and shader data.",
    risk: "Rebuilds can be lengthy; an unverified folder may contain other data.",
  },
  "unreal-zen": {
    explanation: "Shared Unreal cache and cooked-output storage.",
    risk: "May contain referenced output; no safe cleanup is established here.",
  },
  "nvidia-shaders": {
    explanation: "Shader data saved by NVIDIA's driver.",
    risk: "Games may rebuild shaders; the documented procedure includes restarts.",
  },
  "directx-shaders": {
    explanation: "Shader data managed by Windows.",
    risk: "Applications may rebuild shaders after Windows clears this category.",
  },
  "npm-cache": {
    explanation: "Downloaded npm packages kept for reuse.",
    risk: "Maintenance changes cached data; later installs may need downloads.",
  },
  "npm-exec-cache": {
    explanation: "Tool runtimes downloaded by npm and npx.",
    risk: "Some entries may be running; removing them can interrupt tools.",
  },
  "pnpm-store": {
    explanation: "Packages shared across pnpm projects.",
    risk: "Pruning may trigger downloads; active runtimes and shared files need care.",
  },
  "gradle-cache": {
    explanation: "Gradle's downloaded and generated build cache.",
    risk: "Later builds may download or rebuild; preserve credentials and configuration.",
  },
  "pip-cache": {
    explanation: "Python package downloads and built wheels.",
    risk: "Later installs may need downloads or compilation; environments must be preserved.",
  },
  "nuget-http-cache": {
    explanation: "NuGet's downloaded HTTP responses.",
    risk: "Feed access may be needed again; installed global packages must be preserved.",
  },
  "windows-temporary": {
    explanation: "Temporary-data categories managed by Windows.",
    risk: "Wrong categories can remove downloads or session data; review Windows' selection.",
  },
};

const unknownCopy: RoutineCopy = {
  explanation: "Recorded folders requiring individual inspection.",
  risk: "Effects are unverified; inspect the evidence before changing anything.",
};

export function routineCopy(id: string): RoutineCopy {
  return Object.hasOwn(routineCopies, id) ? routineCopies[id] : unknownCopy;
}

/** Structured server fields determine the candidate's route, never its prose. */
export function presentRoutineCandidate(
  definition: RoutineDefinition,
  candidate: RoutineCandidate,
) {
  const known = Object.hasOwn(routineCopies, definition.id);
  const eligibleForReview =
    known &&
    definition.mode === "in-app" &&
    candidate.mode === "in-app" &&
    candidate.cleanupSupported === true &&
    !candidate.blockedReason;
  const qualifiedGuidance =
    known &&
    definition.mode !== "review-only" &&
    candidate.mode === "guided" &&
    !candidate.blockedReason &&
    candidate.guide?.qualified === true &&
    candidate.guide.mode === "guided";
  const reviewOnly = !eligibleForReview && !qualifiedGuidance;
  return {
    eligibleForReview,
    qualifiedGuidance,
    reviewOnly,
    kind: eligibleForReview
      ? ("cleanup" as const)
      : qualifiedGuidance
        ? ("guidance" as const)
        : ("inspection" as const),
    label: eligibleForReview
      ? "Review cleanup"
      : qualifiedGuidance
        ? "View guidance"
        : "Review only",
    // Retain every word of the server's safety-critical restriction.
    reason: candidate.blockedReason || (reviewOnly ? candidate.reason : null),
  };
}

export type RoutineActionKind =
  | "fix-settings"
  | "check"
  | "retry"
  | "check-again"
  | "review-filters"
  | "review-folders"
  | "view-guidance"
  | "read-guidance"
  | "inspect";
export type RoutineAction = {
  kind: RoutineActionKind;
  label: string;
  disabled: boolean;
  reason: string | null;
};
export type RoutineInteraction = {
  invalidPreset?: { error: string };
  draftValid?: boolean;
  dirty?: boolean;
  evidenceChanged?: boolean;
  busy?: boolean;
  now?: number;
};

const signature = (preset: RoutinePreset) =>
  JSON.stringify([
    preset.routineId,
    preset.policyVersion,
    preset.minimumBytes,
    preset.minimumAgeDays,
    preset.roots,
  ]);

/** Browser presentation only: no requests, persistence, or cleanup authorization. */
export function presentRoutine(
  row: RoutineBatchRow<RoutineRun>,
  interaction: RoutineInteraction = {},
) {
  const { definition, run } = row;
  const now = interaction.now ?? Date.now();
  const known = Object.hasOwn(routineCopies, definition.id);
  const candidates = (run?.candidates ?? []).map((candidate) =>
    presentRoutineCandidate(definition, candidate),
  );
  const counts = {
    eligibleForReview: candidates.filter((item) => item.eligibleForReview)
      .length,
    qualifiedGuidance: candidates.filter((item) => item.qualifiedGuidance)
      .length,
    reviewOnly: candidates.filter((item) => item.reviewOnly).length,
  };
  const restrictions = [
    ...new Set(
      candidates.flatMap((item) => (item.reason ? [item.reason] : [])),
    ),
  ];
  const fresh =
    !!run &&
    typeof row.preparationDeadline === "number" &&
    Number.isFinite(row.preparationDeadline) &&
    Number.isFinite(now) &&
    preparationDeadline(run.checkedAt, now) !== null &&
    now < row.preparationDeadline;
  const changed =
    interaction.evidenceChanged === true ||
    (!!run &&
      (!row.preset || signature(run.parameters) !== signature(row.preset)));
  const invalid =
    interaction.invalidPreset?.error ||
    (row.status === "needs-settings"
      ? row.error || "Saved settings need correction."
      : null) ||
    (interaction.draftValid === false
      ? "Enter a valid size and age before saving or checking."
      : null);
  let action: RoutineAction;
  const setAction = (
    kind: RoutineActionKind,
    label: string,
    reason: string | null = null,
  ): RoutineAction => ({ kind, label, reason, disabled: false });
  if (!known) {
    action = setAction(
      "inspect",
      "Inspect details",
      "This routine's actions are unverified.",
    );
  } else if (invalid) {
    action = setAction("fix-settings", "Fix settings", invalid);
  } else if (row.status === "failed") {
    action = setAction(
      "retry",
      "Try again",
      row.error || "The previous check failed.",
    );
  } else if (!run || ["not-run", "queued", "running"].includes(row.status)) {
    action = setAction(
      "check",
      "Check routine",
      row.status === "running"
        ? "This routine is being checked."
        : "No completed check is available.",
    );
  } else if (!fresh || changed) {
    action = setAction(
      "check-again",
      "Check again",
      changed
        ? "Settings changed. Check again before reviewing cleanup."
        : "Evidence expired or its original check date is unavailable. Check again.",
    );
  } else if (!run.candidates.length) {
    action = setAction(
      "review-filters",
      "Review filters",
      "No matches under saved filters.",
    );
  } else if (counts.eligibleForReview) {
    action = setAction("review-folders", "Review folders");
  } else if (counts.qualifiedGuidance) {
    action = setAction("view-guidance", "View guidance");
  } else if (
    run.candidates.some((candidate) => candidate.guide) ||
    definition.evidence.length
  ) {
    action = setAction(
      "read-guidance",
      "Read guidance",
      "Review only. No qualified cleanup action is available.",
    );
  } else {
    action = setAction(
      "inspect",
      "Inspect details",
      "Review only. Inspect each folder's restrictions.",
    );
  }
  const checkAction = ["check", "retry", "check-again"].includes(action.kind);
  const busy = interaction.busy === true || row.status === "running";
  const dirty = interaction.dirty === true;
  const availabilityReason = busy
    ? "A routine check or preset save is in progress. Browsing remains available."
    : dirty
      ? "Unsaved changes. Save preset or use saved settings, then repeat your action."
      : null;
  if (checkAction && availabilityReason) {
    action = {
      ...action,
      disabled: true,
      reason: [action.reason, availabilityReason].filter(Boolean).join(" "),
    };
  }
  return {
    ...routineCopy(definition.id),
    action,
    counts,
    restrictions,
    fresh,
    availabilityReason,
    canSwitch: !dirty,
    canSave: !busy && interaction.draftValid !== false,
    // The explicit expanded check may use valid draft parameters.
    canCheckDraft:
      known && !busy && !invalid && interaction.draftValid !== false,
    canPrepare:
      !busy &&
      !dirty &&
      !invalid &&
      !changed &&
      fresh &&
      action.kind === "review-folders",
    canRunAll: !busy && !dirty,
  };
}
