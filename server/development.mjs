import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
export const targetId = (p) =>
  createHash("sha256")
    .update(path.resolve(p).toLowerCase())
    .digest("hex")
    .slice(0, 24);
export const within = (p, root) => {
  const r = path.relative(root, p);
  return (
    r === "" ||
    (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
  );
};
export async function git(cwd, ...args) {
  const { stdout } = await exec(
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
      timeout: 20000,
      maxBuffer: 8 * 1024 ** 2,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return stdout;
}
const exists = async (p) => {
  try {
    return await lstat(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
export function normalizeRoots(roots) {
  if (!Array.isArray(roots) || roots.length > 30)
    throw new Error("Use up to 30 development roots.");
  const found = new Map();
  for (let p of roots) {
    if (
      typeof p !== "string" ||
      !p.trim() ||
      p.length > 1000 ||
      /[\0\r\n]/.test(p)
    )
      throw new Error("Invalid development root.");
    p = p.trim().replace(/^~(?=[\\/]|$)/, homedir());
    if (!path.isAbsolute(p))
      throw new Error("Use an absolute development root or ~/repos.");
    p = path.resolve(p);
    if (
      p === path.parse(p).root ||
      p.toLowerCase() === homedir().toLowerCase() ||
      (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(p))
    )
      throw new Error(
        "Choose a project folder, not a drive, home or network root.",
      );
    found.set(p.toLowerCase(), p);
  }
  return [...found.values()];
}
export async function describeGenerated(target) {
  target = path.resolve(target);
  const parent = path.dirname(target),
    name = path.basename(target).toLowerCase();
  const info = await exists(target);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(parent, "package.json"), "utf8"),
    );
  } catch {}
  let label, restore, reason;
  if (name === "node_modules" && manifest) {
    const locks = await Promise.all(
      [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
      ].map((n) => exists(path.join(parent, n))),
    );
    if (!locks.some(Boolean)) return null;
    label = "Installed Node packages";
    restore =
      locks[0] || locks[1]
        ? "npm ci"
        : locks[2]
          ? "pnpm install --frozen-lockfile"
          : locks[3]
            ? "yarn install --immutable"
            : "bun install --frozen-lockfile";
    reason =
      "Adjacent package manifest and lockfile provide an installation record.";
  } else if (
    ["build", "dist", ".next", "out"].includes(name) &&
    typeof manifest?.scripts?.build === "string"
  ) {
    label = "JavaScript build output";
    restore =
      "Run the project’s build script (npm run build, or the configured package manager).";
    reason =
      "Adjacent package.json defines a build script. Confirm the output has no hand-edited files.";
  } else if (name === "intermediate") {
    const projects = (await readdir(parent)).filter((n) =>
      /\.uproject$/i.test(n),
    );
    if (
      projects.length !== 1 ||
      !(await exists(path.join(parent, "Source")))?.isDirectory()
    )
      return null;
    let project;
    try {
      project = JSON.parse(
        await readFile(path.join(parent, projects[0]), "utf8"),
      );
    } catch {
      return null;
    }
    if (!Array.isArray(project.Modules) || !project.Modules.length) return null;
    label = "Unreal project intermediates";
    restore =
      "Regenerate project files and rebuild this project's C++ targets with its configured Unreal Engine and toolchain.";
    reason =
      "An adjacent Unreal project with native modules and source identifies temporary build output. Preserve Build, Source, Content, Config, Plugins and Saved.";
  } else if (
    name === "target" &&
    (await exists(path.join(parent, "Cargo.toml")))
  ) {
    label = "Rust build output";
    restore = "cargo build (the next build recompiles these artifacts)";
    reason = "Adjacent Cargo.toml identifies the Rust project.";
  } else if (
    ["bin", "obj"].includes(name) &&
    (await readdir(parent)).some((n) => /\.(csproj|fsproj|vbproj)$/i.test(n))
  ) {
    label = ".NET build output";
    restore = "dotnet restore && dotnet build";
    reason =
      "An adjacent .NET project identifies these outputs. Stop any running deployment first.";
  } else if (
    name === "library" &&
    (await exists(path.join(parent, "Assets")))?.isDirectory() &&
    (await exists(path.join(parent, "ProjectSettings")))?.isDirectory()
  ) {
    label = "Unity Library";
    restore =
      "Reopen the project in Unity; a full asset reimport may take considerable time.";
    reason =
      "Adjacent Assets and ProjectSettings identify a Unity project. Preserve Assets, Packages and ProjectSettings.";
  } else if (
    name === ".godot" &&
    (await exists(path.join(parent, "project.godot")))
  ) {
    label = "Godot generated cache";
    restore = "Reopen the project in Godot to reimport assets.";
    reason =
      "Adjacent project.godot identifies the project. Preserve source assets and .import sidecars.";
  } else if (
    [".venv", "venv"].includes(name) &&
    (await exists(path.join(target, "pyvenv.cfg")))
  ) {
    if (
      !(
        await Promise.all(
          [
            "requirements.txt",
            "pyproject.toml",
            "Pipfile",
            "environment.yml",
          ].map((n) => exists(path.join(parent, n))),
        )
      ).some(Boolean)
    )
      return null;
    label = "Python environment";
    restore =
      "Recreate the virtual environment and install from the project’s requirements or environment manager.";
    reason =
      "A virtual environment marker and adjacent dependency manifest exist; verify private dependencies remain available.";
  } else return null;
  return {
    id: targetId(target),
    path: target,
    kind: "generated",
    label,
    projectPath: parent,
    restore,
    reason,
  };
}
export async function inspectWorktree(target) {
  const blocked = (reason) => ({ eligible: false, blockedReason: reason });
  let records;
  try {
    records = parseWorktrees(
      await git(target, "worktree", "list", "--porcelain", "-z"),
    );
  } catch {
    return blocked("Git worktree metadata is unavailable.");
  }
  const record = records.find(
    (r) =>
      path.resolve(r.worktree).toLowerCase() ===
      path.resolve(target).toLowerCase(),
  );
  if (!record || record === records[0])
    return blocked("The main checkout cannot be removed.");
  if (record.locked !== undefined) return blocked("This worktree is locked.");
  if (record.prunable !== undefined)
    return blocked(
      "This worktree is missing or prunable; repair its Git registration first.",
    );
  if (
    (await git(target, "ls-files", "-v", "-z"))
      .split("\0")
      .some((s) => s && (s[0] === s[0].toLowerCase() || s[0] === "S"))
  )
    return blocked(
      "Git assume-unchanged or skip-worktree flags can hide local edits. Clear those flags and inspect the worktree first.",
    );
  if (
    (await git(target, "ls-files", "--stage", "-z"))
      .split("\0")
      .some((s) => s.startsWith("160000 "))
  )
    return blocked("Worktrees containing submodules require manual review.");
  const entries = (
    await git(
      target,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
      "-z",
    )
  )
    .split("\0")
    .filter(Boolean);
  const ignored = [];
  for (const entry of entries) {
    if (!entry.startsWith("!! "))
      return blocked(
        "Tracked changes or untracked files must be preserved first.",
      );
    const p = path.resolve(target, entry.slice(3).replace(/[\\/]$/, ""));
    if (!within(p, target) || !(await describeGenerated(p)))
      return blocked(
        "Unknown ignored files or folders need review: " + entry.slice(3),
      );
    ignored.push(p);
  }
  const preservedBy = (
    await git(
      target,
      "for-each-ref",
      "--contains",
      record.HEAD,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    )
  )
    .trim()
    .split("\n")
    .filter((r) => r && r !== record.branch);
  if (!preservedBy.length)
    return blocked(
      "Worktree commits have no other branch or remote reference preserving them.",
    );
  return {
    eligible: true,
    head: record.HEAD,
    branch: record.branch || "Detached HEAD",
    preservedBy,
    ignored,
    mainPath: records[0].worktree,
  };
}
export function parseWorktrees(text) {
  return text
    .split("\0\0")
    .filter(Boolean)
    .map((block) =>
      Object.fromEntries(
        block
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf(" ");
            return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
          }),
      ),
    );
}
export const discoveryOperations = [
  "all",
  "worktrees",
  "stale-worktrees",
  "builds",
  "dependencies",
  "caches",
];
const buildNames = new Set([
  "intermediate",
  "build",
  "dist",
  ".next",
  "out",
  "target",
  "bin",
  "obj",
  "library",
  ".godot",
]);
const dependencyNames = new Set(["node_modules", ".venv", "venv"]);
const cacheNames = new Set([
  "cache",
  "caches",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "_cacache",
  ".turbo",
]);
export async function describeDiscoveryTarget(target) {
  const info = await exists(target);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  const name = path.basename(target).toLowerCase();
  const category = buildNames.has(name)
    ? "builds"
    : dependencyNames.has(name)
      ? "dependencies"
      : cacheNames.has(name)
        ? "caches"
        : null;
  if (!category) return null;
  const verified =
    category === "caches" ? null : await describeGenerated(target);
  return {
    ...(verified || {
      id: targetId(target),
      path: target,
      kind: "generated",
      projectPath: path.dirname(target),
      label:
        category === "caches"
          ? "Cache folder to review"
          : category === "dependencies"
            ? "Dependency folder to review"
            : "Build folder to review",
      reason:
        "The folder name matches this operation, but reproducibility has not been verified.",
      restore:
        "Review the owning application or project instructions. This name match does not enable deletion.",
    }),
    category,
    cleanupSupported: Boolean(verified),
  };
}
export async function discoverDevelopment(roots, options = {}) {
  const operation = options.operation || "all";
  if (!discoveryOperations.includes(operation))
    throw new Error("Unknown discovery operation.");
  const maxDirectories = options.maxDirectories ?? 100000;
  const coverage = {
    directoriesVisited: 0,
    skippedSubtrees: 0,
    complete: true,
    directoryLimit: maxDirectories,
  };
  const targets = new Map(),
    projects = [],
    notices = [],
    seen = new Set(),
    repos = new Set();
  roots = normalizeRoots(roots);
  const excluded = (p) =>
    (options.exclusions || []).some((e) =>
      path.isAbsolute(e)
        ? within(p, path.resolve(e))
        : p
            .split(path.sep)
            .some((part) => part.toLowerCase() === e.toLowerCase()),
    ) ||
    (options.skipCloud !== false &&
      p.split(path.sep).some((part) => /^OneDrive/i.test(part)));
  const activity = new Map();
  const pending = [...roots];
  while (pending.length) {
    const p = pending.pop();
    if (seen.has(p.toLowerCase())) continue;
    if (coverage.directoriesVisited >= maxDirectories) {
      coverage.complete = false;
      notices.push(
        "Development discovery reached its directory limit. Add more specific roots.",
      );
      break;
    }
    seen.add(p.toLowerCase());
    coverage.directoriesVisited++;
    if (excluded(p)) {
      coverage.skippedSubtrees++;
      continue;
    }
    try {
      const st = await lstat(p);
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        path.resolve(await realpath(p)).toLowerCase() !== p.toLowerCase()
      )
        continue;
      const desc = await describeDiscoveryTarget(p);
      if (desc) {
        if (targets.get(desc.id)?.kind !== "worktree")
          targets.set(desc.id, desc);
        const name = path.basename(p).toLowerCase();
        const sourceContainer =
          roots.some((root) => root.toLowerCase() === p.toLowerCase()) ||
          Boolean(await exists(path.join(p, ".git")));
        const conventionalArtifact =
          dependencyNames.has(name) ||
          (cacheNames.has(name) && !["cache", "caches"].includes(name));
        if (
          !sourceContainer &&
          (desc.cleanupSupported || conventionalArtifact)
        ) {
          coverage.skippedSubtrees++;
          continue;
        }
      }
      const entries = await readdir(p, { withFileTypes: true });
      if (entries.some((e) => e.name === ".git")) {
        projects.push({ path: p });
        if (["all", "worktrees", "stale-worktrees"].includes(operation))
          try {
            const common = (
              await git(
                p,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              )
            ).trim();
            if (!repos.has(common.toLowerCase())) {
              repos.add(common.toLowerCase());
              const worktrees = parseWorktrees(
                await git(p, "worktree", "list", "--porcelain", "-z"),
              );
              const heads = [
                ...new Set(
                  worktrees
                    .map((w) => w.HEAD)
                    .filter((h) => /^[a-f\d]{40,64}$/i.test(h)),
                ),
              ];
              const dates = new Map();
              if (heads.length)
                try {
                  for (const line of (
                    await git(
                      p,
                      "log",
                      "--no-walk",
                      "--format=%H%x00%cI",
                      ...heads,
                    )
                  )
                    .trim()
                    .split("\n")) {
                    const [head, date] = line.split("\0");
                    dates.set(head, date);
                  }
                } catch {}
              for (const wt of worktrees)
                activity.set(path.resolve(wt.worktree), dates.get(wt.HEAD));
              for (const wt of worktrees.slice(1)) {
                const target = path.resolve(wt.worktree);
                if (!roots.some((root) => within(target, path.resolve(root))))
                  continue;
                if (excluded(target)) continue;
                const lastCommitAt = dates.get(wt.HEAD);
                const id = targetId(target);
                targets.set(id, {
                  id,
                  path: target,
                  kind: "worktree",
                  category: "worktrees",
                  cleanupSupported: true,
                  label: "Linked Git worktree",
                  projectPath: p,
                  branch: wt.branch || "Detached HEAD",
                  lastCommitAt,
                  locked: wt.locked !== undefined,
                  reason:
                    "Registered with Git. Age is a review hint; eligibility is checked when preparing deletion.",
                  restore:
                    "The branch is retained. Recreate a worktree from its preserved commit or branch.",
                });
                pending.push(target);
              }
            }
          } catch (e) {
            coverage.complete = false;
            notices.push(
              `${p}: Git metadata could not be inspected. ${e.message}`,
            );
          }
      }
      for (const e of entries)
        if (
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          ![".git", ".recycle"].includes(e.name.toLowerCase())
        )
          pending.push(path.join(p, e.name));
    } catch (e) {
      coverage.complete = false;
      notices.push(`${p}: ${e.message}`);
    }
  }
  const activityRoots = [...activity.keys()].sort(
    (a, b) => b.length - a.length,
  );
  for (const target of targets.values())
    if (target.kind === "generated") {
      const repo = activityRoots.find((p) => within(target.path, p));
      if (repo) target.lastCommitAt = activity.get(repo);
    }
  const matches = [...targets.values()].filter(
    (t) =>
      operation === "all" ||
      t.category === operation ||
      (operation === "stale-worktrees" &&
        t.category === "worktrees" &&
        t.lastCommitAt &&
        Date.now() - Date.parse(t.lastCommitAt) >
          (options.staleDays ?? 90) * 86400000),
  );
  if (operation === "stale-worktrees") {
    const unknown = [...targets.values()].filter(
      (t) => t.kind === "worktree" && !t.lastCommitAt,
    ).length;
    if (unknown) {
      coverage.complete = false;
      notices.push(
        `${unknown} worktrees have no readable commit date and could not be assessed by age.`,
      );
    }
  }
  return { targets: matches, projects, notices, coverage, operation, roots };
}
