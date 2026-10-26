import path from "node:path";
import { createHash } from "node:crypto";

export function selectedBytes(findings, ids, files) {
  const wanted = new Set(ids);
  const paths = new Set(
    findings.filter((f) => wanted.has(f.id)).flatMap((f) => f.filePaths),
  );
  return files.reduce((sum, f) => sum + (paths.has(f.path) ? f.size : 0), 0);
}

export function analyze(
  files,
  directories,
  options,
  duplicateGroups,
  shouldStop = () => false,
) {
  const now = Date.now();
  const findings = [];
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const directoryPaths = new Set(directories.map((d) => d.path.toLowerCase()));
  const dotnetProjects = new Set(
    files
      .filter((f) => /\.(csproj|fsproj|vbproj)$/i.test(f.path))
      .map((f) => path.dirname(f.path).toLowerCase()),
  );
  const covered = new Set();
  const coveredRoots = [];
  const add = (
    category,
    title,
    target,
    members,
    risk,
    reason,
    impact,
    action,
    evidence,
  ) => {
    const bytes = members.reduce((n, f) => n + f.size, 0);
    if (bytes < options.minimumBytes) return;
    findings.push({
      id: createHash("sha1")
        .update(category + target)
        .digest("hex")
        .slice(0, 16),
      category,
      title,
      path: target,
      bytes,
      filePaths: members.map((f) => f.path),
      fileCount: members.length,
      risk,
      reason,
      impact,
      action,
      evidence,
      confidence: risk === "low" ? "High" : "Review needed",
      score: Math.round(Math.log2(bytes + 1) * (risk === "low" ? 3 : 1.8)),
      modifiedAt: Math.max(...members.slice(0, 10000).map((f) => f.mtimeMs)),
    });
  };
  for (const dir of [...directories].sort(
    (a, b) => a.path.length - b.path.length,
  )) {
    if (shouldStop()) break;
    if (coveredRoots.some((root) => dir.path.startsWith(root + path.sep)))
      continue;
    if (dir.path.split(path.sep).includes(".git")) continue;
    const name = path.basename(dir.path).toLowerCase();
    const parent = path.dirname(dir.path);
    const pythonEnv =
      [".venv", "venv"].includes(name) &&
      byPath.has(path.join(dir.path, "pyvenv.cfg").toLowerCase());
    let rule;
    if (
      name === "node_modules" &&
      !byPath.has(path.join(parent, "package.json").toLowerCase())
    )
      rule = [
        "dependencies",
        "Dependency folder to review",
        "This folder matches a dependency-folder name, but no adjacent package manifest was found.",
        "These may be vendored or manually modified packages with no reliable way to restore them.",
        "Find the owning project and confirm a reproducible installation before removing anything.",
        "review",
      ];
    else if (
      pythonEnv &&
      ![
        "requirements.txt",
        "pyproject.toml",
        "Pipfile",
        "environment.yml",
      ].some((file) => byPath.has(path.join(parent, file).toLowerCase()))
    )
      rule = [
        "dependencies",
        "Python environment to review",
        "This is a Python environment, but no adjacent dependency manifest was found.",
        "The installed packages may not have a reproducible installation record.",
        "Export and verify the environment requirements before removing it.",
        "review",
      ];
    else if (name === "node_modules" || pythonEnv)
      rule = [
        "dependencies",
        "Rebuildable dependencies",
        "Installed packages can be restored from the project manifest.",
        "Your project will need its packages installed again. Keep manifests and lockfiles.",
        "Close the project, review this folder, then reinstall packages when needed.",
      ];
    else if (
      name === "library" &&
      directoryPaths.has(path.join(parent, "Assets").toLowerCase()) &&
      directoryPaths.has(path.join(parent, "ProjectSettings").toLowerCase())
    )
      rule = [
        "builds",
        "Unity import and build cache",
        "Assets and ProjectSettings identify the adjacent Unity project.",
        "Unity will reimport assets and rebuild this cache, which can take considerable time. Preserve Assets, Packages and ProjectSettings.",
        "Close Unity, confirm the project sources are backed up, then review the Library folder.",
      ];
    else if (
      name === ".godot" &&
      byPath.has(path.join(parent, "project.godot").toLowerCase())
    )
      rule = [
        "builds",
        "Godot project cache",
        "A project.godot file identifies the owning Godot project.",
        "Godot will reimport source assets and rebuild its project cache. Preserve source assets and adjacent .import configuration files.",
        "Close Godot and verify the source assets before reviewing this generated folder.",
      ];
    else if (
      name === "repository" &&
      path.basename(parent).toLowerCase() === ".m2"
    )
      rule = [
        "caches",
        "Maven local repository",
        "This repository can contain both downloaded dependencies and locally installed artifacts.",
        "Locally installed or unpublished artifacts may not be available from any remote repository.",
        "Back up unpublished artifacts and verify their source projects before considering cleanup.",
        "review",
      ];
    else if (
      ["bin", "obj"].includes(name) &&
      dotnetProjects.has(parent.toLowerCase())
    )
      rule = [
        "builds",
        ".NET build output",
        "A .NET project file is present beside this build-output folder.",
        "Confirm these outputs are reproducible and are not a running deployment.",
        "Stop the application and use dotnet clean from the owning project.",
      ];
    else if (
      (name === "packages" &&
        path.basename(parent).toLowerCase() === ".nuget") ||
      (name === "caches" && path.basename(parent).toLowerCase() === ".gradle")
    )
      rule = [
        "caches",
        "Downloaded package cache",
        "This matches a known package-manager cache location.",
        "Future builds may need to download packages again and require access to their original feeds.",
        "Close active builds and use the package manager’s cache-cleaning command.",
      ];
    else if (
      [".cache", "__pycache__", ".pytest_cache", ".mypy_cache"].includes(
        name,
      ) ||
      name === "_cacache" ||
      (name === "cache" && path.basename(parent) === ".next")
    )
      rule = [
        "caches",
        "Application cache",
        "This folder matches a known cache location.",
        "The owning application may rebuild or download these files.",
        "Close the owning application and use its cache-cleaning command.",
      ];
    else if (
      ["dist", "build", ".next"].includes(name) &&
      byPath.has(path.join(parent, "package.json").toLowerCase())
    )
      rule = [
        "builds",
        "Generated project output",
        "A package manifest sits beside this generated-output folder.",
        "Confirm these files can be rebuilt and do not contain hand-edited work.",
        "Inspect the build script and source, then rebuild to confirm reproducibility.",
      ];
    else if (
      name === "target" &&
      byPath.has(path.join(parent, "Cargo.toml").toLowerCase())
    )
      rule = [
        "builds",
        "Rust build output",
        "This target folder belongs to a Cargo project.",
        "The next Cargo build will take longer.",
        "Use cargo clean from the owning project after reviewing it.",
      ];
    if (!rule) continue;
    const members = files.filter(
      (f) => f.path.startsWith(dir.path + path.sep) && !covered.has(f.path),
    );
    if (!members.length) continue;
    coveredRoots.push(dir.path);
    const linked = members.some((f) => f.nlink > 1);
    add(
      rule[0],
      rule[1],
      dir.path,
      members,
      rule[5] === "review" || rule[0] === "builds" || linked ? "review" : "low",
      rule[2],
      rule[3] +
        (linked
          ? " Some files have hardlinks elsewhere; deleting this path may release no storage."
          : ""),
      rule[4],
      [
        `${members.length.toLocaleString()} unique files in a recognized ${rule[0]} folder`,
        "Logical file sizes; allocated space may differ",
      ],
    );
    members.forEach((f) => covered.add(f.path));
  }
  for (const file of files) {
    if (shouldStop()) break;
    if (covered.has(file.path) || file.path.split(path.sep).includes(".git"))
      continue;
    const age = Math.floor((now - file.mtimeMs) / 86400000);
    if (
      /\.(exe|msi|msix|dmg|iso|zip|7z|tar|gz)$/i.test(file.path) &&
      age >= options.staleDays
    )
      add(
        "installers",
        "Old installer or archive",
        file.path,
        [file],
        "review",
        `This installer or archive has not been modified for ${age} days.`,
        "It may be your only backup or installation source. Age alone does not make it disposable.",
        "Confirm the application is installed or the archive is backed up before removing it.",
        [
          `${age} days since modification`,
          `Extension: ${path.extname(file.path)}`,
        ],
      );
    else if (
      /\.(dll|so|dylib)$/i.test(file.path) &&
      file.size >= options.largeFileBytes &&
      age >= options.staleDays
    )
      add(
        "large",
        "Application component — review the whole application",
        file.path,
        [file],
        "review",
        `This older library is part of an application or development tool; its age does not establish inactivity.`,
        "Removing an individual application library can break the installed tool.",
        "Review or uninstall the owning application instead of deleting this component.",
        [
          `${age} days since modification`,
          "Application library extension; last use is unknown",
        ],
      );
    else if (file.size >= options.largeFileBytes && age >= options.staleDays)
      add(
        "large",
        "Large, older file",
        file.path,
        [file],
        "review",
        `A large file has not changed for ${age} days.`,
        "This may be valuable work. Modification time does not show when you last opened it.",
        "Open the containing folder and decide whether to keep, archive or remove it.",
        [`${age} days since modification`, "Last-access time is not used"],
      );
  }
  for (const group of duplicateGroups) {
    if (shouldStop()) break;
    // Package and generated artifacts can require identical files in different locations.
    if (
      group.files.some((f) =>
        coveredRoots.some((root) => f.path.startsWith(root + path.sep)),
      )
    )
      continue;
    add(
      "duplicates",
      `${group.files.length} identical copies`,
      group.files[1].path,
      group.files.slice(1),
      "review",
      "These files have matching full SHA-256 hashes and stable sizes and modification times.",
      "Keep at least one copy. Identical files in different projects may both be needed.",
      `Review every location. Suggested keeper: ${group.files[0].path}`,
      [
        `SHA-256: ${group.hash}`,
        `${group.files.length - 1} extra copies; one suggested keeper`,
      ],
    );
  }
  return findings.sort((a, b) => b.score - a.score || b.bytes - a.bytes);
}
