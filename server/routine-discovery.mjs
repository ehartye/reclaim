import { lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  describeGenerated,
  parseWorktrees,
  within,
  normalizeRoots,
} from "./development.mjs";
import {
  getRoutineDefinition,
  routineMode,
  generatedRoutineId,
  supportsRoutinePreparation,
} from "./routine-policies.mjs";
import { validateRoutinePreset } from "./routine-presets.mjs";
import { routineSizeMatches } from "../shared/routines.ts";

const proofs = new WeakMap();
const exec = promisify(execFile);
const snapshotSettings = (settings) => ({
  ...settings,
  developmentRoots: [...(settings.developmentRoots || [])],
  exclusions: [...(settings.exclusions || [])],
});
const budgetError = () =>
  Object.assign(
    new Error(
      "Discovery time budget elapsed; results are partial. Rerun before cleanup review.",
    ),
    { code: "ROUTINE_BUDGET" },
  );
function discoveryBudget(started, budgetMs, now) {
  const deadline = started + budgetMs;
  const wallDeadline = Date.now() + budgetMs;
  const remaining = () => Math.min(deadline - now(), wallDeadline - Date.now());
  const wait = (operation) =>
    new Promise((resolve, reject) => {
      const milliseconds = remaining();
      if (milliseconds <= 0) return reject(budgetError());
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        reject(budgetError());
      }, milliseconds);
      Promise.resolve()
        .then(() => {
          if (finished || remaining() <= 0) throw budgetError();
          return operation(Math.max(1, Math.ceil(remaining())));
        })
        .then(
          (result) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (remaining() <= 0) reject(budgetError());
            else resolve(result);
          },
          (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  return { remaining, wait };
}
export function unionRoutineCandidates(runs) {
  const result = [];
  for (const candidate of runs
    .flatMap((run) => run.candidates || [])
    .sort((a, b) => a.path.length - b.path.length)) {
    if (!result.some((parent) => within(candidate.path, parent.path)))
      result.push(candidate);
  }
  return result;
}
const generatedNames = new Set([
  "node_modules",
  "build",
  "dist",
  ".next",
  "out",
  "target",
  "bin",
  "obj",
  "intermediate",
  "library",
  ".godot",
  ".venv",
  "venv",
]);
const identity = (st) => [st.dev, st.ino, st.birthtimeMs, st.mtimeMs].join(":");
const key = (p) =>
  process.platform === "win32"
    ? path.resolve(p).toLowerCase()
    : path.resolve(p);
const stateKey = (settings) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        roots: settings.developmentRoots || [],
        exclusions: settings.exclusions || [],
        skipCloud: settings.skipCloud !== false,
      }),
    )
    .digest("hex");
const excluded = (p, settings, report) =>
  p
    .split(path.sep)
    .some(
      (part) =>
        part.toLowerCase() === ".git" ||
        (settings.skipCloud !== false && /^OneDrive/i.test(part)),
    ) ||
  [...(settings.exclusions || []), ...(report?.options?.exclusions || [])].some(
    (e) =>
      path.isAbsolute(e)
        ? within(p, path.resolve(e))
        : p
            .split(path.sep)
            .some((part) => part.toLowerCase() === e.toLowerCase()),
  );

function excludedDescendants(p, settings, report) {
  const exclusions = [
    ...(settings.exclusions || []),
    ...(report?.options?.exclusions || []),
  ];
  if (exclusions.some((e) => path.isAbsolute(e) && within(path.resolve(e), p)))
    return "An excluded path is inside this scope. Preserve the containing folder.";
  if (exclusions.some((e) => !path.isAbsolute(e)))
    return "Named exclusions may occur inside this scope. Discovery has not inventoried every descendant; review manually.";
  return null;
}

const unbounded = (operation) => operation(30000);
async function checkedDirectory(p, wait = unbounded) {
  const st = await wait(() => lstat(p));
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    key(await wait(() => realpath(p))) !== key(p)
  )
    throw new Error(
      "Linked, unavailable or non-directory scope requires review.",
    );
  return st;
}

// These are discovery leads, never mutation scopes. A configured owner location
// supplied by a trusted guide resolver replaces these defaults, not a request path.
export function defaultRoutineScopes(
  routineId,
  { home = homedir(), localAppData = process.env.LOCALAPPDATA } = {},
) {
  const local = localAppData || path.join(home, "AppData", "Local");
  const paths = {
    "unreal-ddc": [
      path.join(local, "UnrealEngine", "Common", "DerivedDataCache"),
    ],
    "unreal-zen": [path.join(local, "UnrealEngine", "Common", "Zen")],
    "nvidia-shaders": [
      path.join(local, "NVIDIA", "DXCache"),
      path.join(local, "NVIDIA", "GLCache"),
    ],
    "npm-cache": [path.join(local, "npm-cache", "_cacache")],
    "npm-exec-cache": [path.join(local, "npm-cache", "_npx")],
    "gradle-cache": [path.join(home, ".gradle", "caches")],
    "pnpm-store": [path.join(local, "pnpm", "store")],
    "directx-shaders": [path.join(local, "D3DSCache")],
    "pip-cache": [path.join(local, "pip", "Cache")],
    "nuget-http-cache": [path.join(local, "NuGet", "v3-cache")],
    "windows-temporary": [path.join(local, "Temp")],
  };
  return (paths[routineId] || []).map((scopePath) => ({
    path: scopePath,
    reason:
      "Default owner-location lead only; configured role and current eligible bytes are unverified.",
  }));
}

async function boundedGit(cwd, args, wait) {
  const result = await wait((timeout) =>
    exec(
      "git",
      [
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout,
        maxBuffer: 8 * 1024 ** 2,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    ),
  );
  return result.stdout;
}

async function projectDescription(p, routineId, wait = unbounded) {
  if (routineId === "linked-worktrees") {
    const marker = await wait(() => lstat(path.join(p, ".git")));
    if (!marker.isFile() || marker.isSymbolicLink()) return null;
    let blockedReason =
      "Git worktree registration is unavailable. Review this marker-only lead manually.";
    let registered = false;
    try {
      const records = parseWorktrees(
        await boundedGit(p, ["worktree", "list", "--porcelain", "-z"], wait),
      );
      const record = records.find(
        (entry) => entry.worktree && key(entry.worktree) === key(p),
      );
      if (!record)
        blockedReason =
          "The Git marker is not a registered linked worktree. Review manually.";
      else if (record === records[0])
        blockedReason = "The main checkout cannot be removed.";
      else if (record.locked !== undefined)
        blockedReason = "This worktree is locked.";
      else if (record.prunable !== undefined)
        blockedReason =
          "This worktree is prunable; repair its registration first.";
      else {
        registered = true;
        blockedReason = null;
      }
    } catch (error) {
      if (error.code === "ROUTINE_BUDGET") throw error;
    }
    return {
      kind: "worktree",
      label: "Linked Git worktree",
      restore:
        "Recreate from a preserved reference after fresh inspection verifies that the commits are preserved.",
      reason: registered
        ? "Registered linked worktree. Fresh cleanup review must still verify local changes, ignored content and preserved commits before removal."
        : "A Git marker file identifies a possible linked worktree; registration and removal eligibility are unverified.",
      blockedReason,
    };
  }
  if (!generatedNames.has(path.basename(p).toLowerCase())) return null;
  const description = await wait(() => describeGenerated(p));
  if (generatedRoutineId(description) !== routineId) return null;
  try {
    const root = (
      await boundedGit(p, ["rev-parse", "--show-toplevel"], wait)
    ).trim();
    if (
      (
        await boundedGit(
          root,
          ["ls-files", "-z", "--", path.relative(root, p)],
          wait,
        )
      ).length
    )
      return {
        ...description,
        blockedReason: "Contains tracked project content. Preserve it.",
      };
  } catch (error) {
    if (error.code === "ROUTINE_BUDGET") throw error;
    if (!/not a git repository/i.test(error.stderr || ""))
      return {
        ...description,
        blockedReason:
          "Git ownership evidence is unavailable; review manually.",
      };
  }
  return description;
}

export async function discoverRoutine({
  routineId,
  parameters,
  report,
  settings = {},
  protectedReason = () => null,
  guideScopes,
  guideForCandidate,
  maxDirectories = 10000,
  budgetMs = 30000,
  now = Date.now,
} = {}) {
  // Copy mutable caller-owned policy state before the first asynchronous boundary.
  settings = snapshotSettings(settings);
  const initialSettingsKey = stateKey(settings);
  if (report)
    report = {
      ...report,
      options: {
        ...report.options,
        exclusions: [...(report.options?.exclusions || [])],
      },
      directories: (report.directories || []).map((row) => ({ ...row })),
    };
  const definition = getRoutineDefinition(routineId);
  if (
    !Number.isSafeInteger(maxDirectories) ||
    maxDirectories < 0 ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 0
  )
    throw new Error("Use a finite discovery budget and directory limit.");
  const preset = validateRoutinePreset(
    { ...parameters, routineId },
    { roots: settings.developmentRoots || [] },
  );
  const started = now();
  const budget = discoveryBudget(started, Math.min(30000, budgetMs), now);
  const limit = Math.min(10000, Math.max(0, maxDirectories));
  const rows = new Map(
    (report?.directories || [])
      .filter(
        (d) =>
          typeof d.path === "string" &&
          path.isAbsolute(d.path) &&
          (!report.root || within(d.path, report.root)),
      )
      .map((d) => [key(d.path), d]),
  );
  const errors = [],
    candidates = [],
    records = new Map();
  const roots = normalizeRoots(
    preset.roots.length ? preset.roots : settings.developmentRoots || [],
  );
  const scopeSettings = {
    ...settings,
    skipCloud:
      settings.skipCloud !== false || report?.options?.skipCloud === true,
  };
  let complete = true,
    checkedDirectories = 0,
    candidateCount = 0;
  const project = definition.scope === "project";
  let scopes = project
    ? [...rows.values()]
        .filter(
          (d) =>
            roots.some((root) => within(d.path, root)) &&
            (routineId === "linked-worktrees"
              ? d.hasGitFile
              : generatedNames.has(path.basename(d.path).toLowerCase())),
        )
        .map((d) => ({ path: d.path }))
    : (guideScopes ?? defaultRoutineScopes(routineId));

  // Without saved sizes, discover directory types only. Never enumerate payloads
  // inside generated output or claim a threshold match from the directory name.
  if (project && !report) {
    scopes = [];
    const pending = [...roots],
      seen = new Set();
    let visited = 0;
    while (pending.length && visited < limit && budget.remaining() > 0) {
      const p = pending.pop();
      if (seen.has(key(p)) || excluded(p, scopeSettings, report)) continue;
      seen.add(key(p));
      visited++;
      try {
        await checkedDirectory(p, budget.wait);
        const names = await budget.wait(() =>
          readdir(p, { withFileTypes: true }),
        );
        const isOutput = generatedNames.has(path.basename(p).toLowerCase());
        if (
          routineId === "linked-worktrees"
            ? names.some((d) => d.name === ".git" && d.isFile())
            : isOutput
        )
          scopes.push({ path: p });
        if (!isOutput)
          for (const entry of names)
            if (
              entry.isDirectory() &&
              !entry.isSymbolicLink() &&
              entry.name !== ".git"
            )
              pending.push(path.join(p, entry.name));
      } catch (error) {
        errors.push({ path: p, reason: error.message });
        if (error.code === "ROUTINE_BUDGET") complete = false;
      }
    }
    if (pending.length) complete = false;
  }
  scopes = scopes.filter(
    (scope) =>
      scope &&
      typeof scope.path === "string" &&
      path.isAbsolute(scope.path) &&
      !excluded(scope.path, scopeSettings, report),
  );
  candidateCount = scopes.length;
  let next = 0;
  async function worker() {
    while (next < scopes.length) {
      if (next >= limit || budget.remaining() <= 0) {
        complete = false;
        return;
      }
      const scope = scopes[next++],
        p = path.resolve(scope.path);
      try {
        const st = await checkedDirectory(p, budget.wait);
        checkedDirectories++;
        const row = rows.get(key(p));
        const logicalBytes =
          Number.isSafeInteger(row?.bytes) && row.bytes >= 0 ? row.bytes : null;
        if (
          logicalBytes !== null &&
          !routineSizeMatches(logicalBytes, preset.minimumBytes)
        )
          continue;
        let description = project
          ? await projectDescription(p, routineId, budget.wait)
          : null;
        if (project && !description) continue;
        const guide = guideForCandidate
          ? await budget.wait(() => guideForCandidate(routineId, p, scope))
          : scope.guide;
        let blockedReason =
          protectedReason(p) ||
          excludedDescendants(p, scopeSettings, report) ||
          scope.blockedReason ||
          description?.blockedReason ||
          null;
        const activity = Math.max(st.mtimeMs || 0, st.birthtimeMs || 0);
        let ageState = "off";
        if (preset.minimumAgeDays !== null) {
          ageState =
            activity > 0
              ? activity >= started - preset.minimumAgeDays * 86400000
                ? "recent"
                : "possible-old"
              : "unknown";
          if (ageState === "recent") continue;
          blockedReason ||=
            "Folder timestamps are only an age hint. Complete fresh descendant activity is not verified; turn the age hint off before preparing cleanup.";
        }
        if (logicalBytes === null)
          blockedReason ||=
            "No recorded size for this exact scope. Run a folder totals scan to verify the threshold; parent-container bytes are not substituted.";
        if (budget.remaining() <= 0) {
          complete = false;
          blockedReason ||=
            "Discovery budget elapsed; rerun before cleanup review.";
        }
        const mode = routineMode(routineId, {
          guideQualified: guide?.qualified === true && guide?.mode === "guided",
          blockedReason,
        });
        const candidate = {
          id: randomBytes(16).toString("hex"),
          path: p,
          mode,
          ...(description
            ? {
                kind: description.kind,
                label: description.label,
                restore: description.restore,
              }
            : {}),
          cleanupSupported: project && mode === "in-app" && !blockedReason,
          ...(blockedReason ? { blockedReason } : {}),
          reason:
            blockedReason ||
            description?.reason ||
            scope.reason ||
            "Owner-managed scope requires a documented guide; ignore status and size do not authorize deletion.",
          logicalBytes,
          estimated: row ? !!row.estimated : false,
          complete: row?.complete === true,
          ...(row ? { recordedAt: row.measuredAt || report.completedAt } : {}),
          newestActivityAt: activity || null,
          ageState,
          ...(guide ? { guide } : {}),
        };
        candidates.push(candidate);
        records.set(candidate.id, { identity: identity(st), candidate });
      } catch (error) {
        errors.push({ path: p, reason: error.message });
        if (error.code === "ROUTINE_BUDGET") complete = false;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, scopes.length) }, worker));
  const outermost = unionRoutineCandidates([{ candidates }]);
  const run = {
    id: randomBytes(16).toString("hex"),
    routineId,
    policyVersion: definition.policyVersion,
    parameters: preset,
    ...(report?.id ? { scanId: report.id } : {}),
    checkedAt: new Date(now()).toISOString(),
    candidates: outermost.sort(
      (a, b) =>
        (b.logicalBytes ?? -1) - (a.logicalBytes ?? -1) ||
        a.path.localeCompare(b.path),
    ),
    coverage: {
      complete: complete && !errors.length,
      candidateCount,
      checkedDirectories,
      errors,
    },
    notices: [
      "Sizes are recorded logical entries from the selected scan, not current allocated or recoverable bytes.",
      "Only outermost scopes are listed; parent and child totals must not be added.",
      "Unknown-size leads have not met the threshold and cannot prepare cleanup. New scans and measurements are separate actions.",
      ...(report?.folderSizing?.estimated
        ? [
            "Quick scan reused dated totals and may omit descendants. Run a fresh scan for fuller size coverage.",
          ]
        : []),
      ...(!complete
        ? [
            "Discovery was limited by its directory or time budget. Narrow the scope or rerun.",
          ]
        : []),
    ],
  };
  proofs.set(run, {
    records,
    settings: initialSettingsKey,
    report,
    expiresAt: now() + 300000,
  });
  return run;
}

export async function revalidateRoutineCandidate(
  run,
  candidateId,
  { settings = {}, protectedReason = () => null, now = Date.now } = {},
) {
  settings = snapshotSettings(settings);
  const proof = proofs.get(run);
  const definition = getRoutineDefinition(run?.routineId);
  const known = proof?.records.get(candidateId);
  if (
    !proof ||
    !known ||
    !run.candidates.includes(known.candidate) ||
    proof.expiresAt < now() ||
    run.policyVersion !== definition.policyVersion ||
    proof.settings !== stateKey(settings)
  )
    throw new Error(
      "Routine evidence is stale or unknown. Run the routine again.",
    );
  const candidate = known.candidate;
  if (!supportsRoutinePreparation(run.routineId, candidate))
    throw new Error(
      "Only existing supported generated folders or worktrees can prepare cleanup; guided caches stay outside this executor.",
    );
  const settingsNow = {
    ...settings,
    skipCloud:
      settings.skipCloud !== false || proof.report?.options?.skipCloud === true,
  };
  if (
    excluded(candidate.path, settingsNow, proof.report) ||
    excludedDescendants(candidate.path, settingsNow, proof.report) ||
    protectedReason(candidate.path)
  )
    throw new Error(
      "The scope is now excluded or protected. Run the routine again.",
    );
  const st = await checkedDirectory(candidate.path);
  if (identity(st) !== known.identity)
    throw new Error(
      "The directory changed. Run the routine again before fresh preparation.",
    );
  const description = await projectDescription(candidate.path, run.routineId);
  if (
    !description ||
    description.blockedReason ||
    (candidate.kind === "generated" &&
      generatedRoutineId(description) !== run.routineId)
  )
    throw new Error(
      description?.blockedReason ||
        "Restoration or ownership evidence changed. Run the routine again.",
    );
  return {
    path: candidate.path,
    kind: description.kind,
    context: run.scanId ? { scanId: run.scanId } : {},
  };
}
