import { ROUTINE_DEFAULT_MINIMUM_BYTES } from "../shared/routines.ts";

const epic =
  "https://dev.epicgames.com/documentation/en-us/unreal-engine/using-derived-data-cache-in-unreal-engine";
const definitions = [
  [
    "unreal-ddc",
    "Unreal filesystem DDC",
    "guided",
    "cache",
    "high",
    "Review the separate local filesystem cache and its regeneration cost.",
    "A configured path is not ownership proof. Unknown layouts, overrides, nested Zen and foreign data stay review-only; no purge command is generated.",
    epic,
  ],
  [
    "nvidia-shaders",
    "NVIDIA shader cache reset",
    "guided",
    "cache",
    "medium",
    "Follow the documented driver reset procedure when space or troubleshooting warrants it.",
    "Close consumers; follow the disable, reboot, specific-cache reset and restore procedure. Never clear the NVIDIA root or change driver settings automatically.",
    "https://nvidia.custhelp.com/app/answers/detail/a_id/5735",
  ],
  [
    "generated-output",
    "Generated project output",
    "in-app",
    "project",
    "medium",
    "Review recognized build outputs and reproducible dependency folders.",
    "Existing project evidence and fresh cleanup checks are required. Preserve inputs, manifests and locks; do not run project clean scripts.",
    "https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-directory-structure",
  ],
  [
    "npm-cache",
    "npm content-cache maintenance",
    "guided",
    "cache",
    "medium",
    "Review the configured npm cache and owner-managed maintenance.",
    "npm cache verify mutates the cache through garbage collection. Full clearing is a separate explicit choice with redownload and offline costs; never run it during discovery.",
    "https://docs.npmjs.com/cli/v11/commands/npm-cache",
  ],
  [
    "gradle-cache",
    "Gradle cache retention",
    "guided",
    "cache",
    "medium",
    "Use Gradle's version-qualified cache retention controls.",
    "Preserve initialization scripts, configuration and credentials; never delete the Gradle user home recursively.",
    "https://docs.gradle.org/current/userguide/directory_layout.html",
  ],
  [
    "pnpm-store",
    "pnpm store pruning",
    "guided",
    "managed-store",
    "medium",
    "Review installed-version support for pruning unreferenced packages.",
    "Scope can include metadata and version-specific execution/global-store/runtime caches. Shared hardlinks and future downloads prevent a promised physical yield.",
    "https://pnpm.io/cli/store",
  ],
  [
    "npm-exec-cache",
    "npm execution-cache review",
    "guided",
    "cache",
    "medium",
    "List and inspect execution-cache keys before selecting any removal.",
    "Preserve active tool runtimes. Only installed-version-qualified selected keys may be suggested; never delete the entire npm parent.",
    "https://docs.npmjs.com/cli/v11/commands/npm-cache",
  ],
  [
    "directx-shaders",
    "Windows DirectX shader cache",
    "guided",
    "cache",
    "medium",
    "Review the Windows-managed shader-cache category.",
    "Use Windows category selection; do not perform a generic filesystem purge.",
    "https://support.microsoft.com/windows/manage-drive-space-with-storage-sense-654f6ada-7bfc-45e5-966b-e24ca05c967e",
  ],
  [
    "pip-cache",
    "pip cache maintenance",
    "guided",
    "cache",
    "medium",
    "Resolve cache dir and info with the same installed Python interpreter.",
    "Purge concerns HTTP and wheel caches, not environments or the entire pip parent. Download/rebuild costs and interpreter identity must be explicit.",
    "https://pip.pypa.io/en/stable/topics/caching/",
  ],
  [
    "nuget-http-cache",
    "NuGet HTTP-cache review",
    "guided",
    "cache",
    "medium",
    "Resolve and review the installed tool's HTTP-cache scope.",
    "Global packages are excluded. Parent .nuget size is not purgeable HTTP-cache size; preserve feed access and do not infer non-use from timestamps.",
    "https://learn.microsoft.com/nuget/consume-packages/managing-the-global-packages-and-cache-folders",
  ],
  [
    "engine-imports",
    "Unity and Godot generated imports",
    "in-app",
    "project",
    "high",
    "Review existing project-qualified import caches.",
    "Reuse existing Unity Library and Godot policies; preserve source assets, metadata and settings. Full reimport can be expensive.",
    "https://docs.unity3d.com/Manual/AssetDatabase.html",
  ],
  [
    "linked-worktrees",
    "Preserved linked worktrees",
    "in-app",
    "project",
    "medium",
    "Review registered linked worktrees using existing Git protections.",
    "Preserve branches, current/main checkouts, local content and unique commits. Commit age is a hint, not last use; never force removal.",
    "https://git-scm.com/docs/git-worktree",
  ],
  [
    "windows-temporary",
    "Windows temporary-data review",
    "guided",
    "cache",
    "low",
    "Review eligible Windows-managed temporary-data categories.",
    "Eligible bytes are unknown until Windows identifies them. Never silently select Downloads, empty Recycle Bin, offload cloud data or recursively purge Temp.",
    "https://support.microsoft.com/windows/manage-drive-space-with-storage-sense-654f6ada-7bfc-45e5-966b-e24ca05c967e",
  ],
  [
    "unreal-zen",
    "Unreal Zen managed storage",
    "review-only",
    "managed-store",
    "high",
    "Inspect the mixed-store role; a separate qualification spike is required.",
    "Zen can hold shared DDC and referenced cooked output. Never remove internal Data/cache/cas directories or infer a safe purge operation.",
    "https://dev.epicgames.com/documentation/en-us/unreal-engine/using-zen-storage-server-as-cooked-output-store-for-unreal-engine",
  ],
];

export const routineDefinitions = Object.freeze(
  definitions.map(
    ([id, label, mode, scope, recoveryCost, description, boundary, url]) =>
      Object.freeze({
        id,
        policyVersion: 1,
        label,
        mode,
        scope,
        recoveryCost,
        description,
        boundary,
        evidence: Object.freeze([url]),
        requiresGuideQualification: mode === "guided",
        supportsAgeHint: scope === "project",
        defaults: Object.freeze({
          minimumBytes: ROUTINE_DEFAULT_MINIMUM_BYTES,
          minimumAgeDays: null,
        }),
      }),
  ),
);
export function getRoutineDefinition(id) {
  if (typeof id !== "string")
    throw new Error("Choose a known cleanup routine.");
  const definition = routineDefinitions.find((item) => item.id === id);
  if (!definition) throw new Error("Choose a known cleanup routine.");
  return definition;
}
// Modes are ceilings, not deletion authorization. Only server-established guide
// qualification can promote a guide out of review-only; fresh cleanup remains mandatory.
export function routineMode(
  id,
  { guideQualified = false, blockedReason = null } = {},
) {
  const definition = getRoutineDefinition(id);
  if (blockedReason || definition.mode === "review-only") return "review-only";
  if (definition.mode === "guided")
    return guideQualified === true ? "guided" : "review-only";
  return "in-app";
}
export function generatedRoutineId(description) {
  if (!description || description.kind !== "generated") return null;
  if (["Unity Library", "Godot generated cache"].includes(description.label))
    return "engine-imports";
  return [
    "Installed Node packages",
    "JavaScript build output",
    "Unreal project intermediates",
    "Rust build output",
    ".NET build output",
    "Python environment",
  ].includes(description.label)
    ? "generated-output"
    : null;
}
export function supportsRoutinePreparation(routineId, candidate) {
  const definition = getRoutineDefinition(routineId);
  if (
    definition.mode !== "in-app" ||
    !candidate ||
    candidate.mode !== "in-app" ||
    candidate.cleanupSupported !== true ||
    candidate.blockedReason
  )
    return false;
  if (routineId === "linked-worktrees") return candidate.kind === "worktree";
  return (
    candidate.kind === "generated" &&
    generatedRoutineId(candidate) === routineId
  );
}
