import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { describeGenerated, git, within } from "./development.mjs";

// Ask Git rather than interpreting .gitignore patterns ourselves. NUL fields
// preserve spaces, tabs, newlines and non-ASCII paths and ignore patterns.
function checkIgnores(root, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        "check-ignore",
        "--stdin",
        "-z",
        "--verbose",
      ],
      {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    let output = "",
      stderr = "",
      failed = false;
    const fail = (error) => {
      if (!failed) {
        failed = true;
        child.kill();
        reject(error);
      }
    };
    const timer = setTimeout(
      () => fail(new Error("Git ignore inspection timed out.")),
      15000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 8 * 1024 ** 2)
        fail(
          new Error(
            "Git ignore output is too large. Choose a narrower search area.",
          ),
        );
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(0, 2000);
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0 && code !== 1)
        return reject(
          new Error(stderr.trim() || "Git ignore inspection failed."),
        );
      const fields = output.split("\0");
      const matches = [];
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const [source, line, pattern, relative] = fields.slice(i, i + 4);
        if (pattern && !pattern.startsWith("!"))
          matches.push({ source, line: Number(line), pattern, relative });
      }
      resolve(matches);
    });
    child.stdin.end(paths.map((p) => p + "\0").join(""));
  });
}

export async function findIgnoredFolders(
  report,
  minimumBytes,
  {
    exclusions = [],
    skipCloud = true,
    protectedReason = () => null,
    maxDirectories = 10000,
    budgetMs = 30000,
  } = {},
) {
  const deadline = Date.now() + budgetMs;
  const groups = new Map(),
    owners = new Map(),
    errors = [],
    skipped = [];
  const candidates = report.directories
    .filter(
      (d) =>
        d.bytes > minimumBytes &&
        within(d.path, report.root) &&
        !d.path
          .split(path.sep)
          .some(
            (part) =>
              part.toLowerCase() === ".git" ||
              (skipCloud && /^OneDrive/i.test(part)),
          ) &&
        !exclusions.some((e) =>
          path.isAbsolute(e)
            ? within(d.path, e)
            : d.path
                .split(path.sep)
                .some((part) => part.toLowerCase() === e.toLowerCase()),
        ),
    )
    .sort((a, b) => b.bytes - a.bytes);
  let complete = true,
    checkedDirectories = 0;
  async function owner(directory) {
    const visited = [];
    let root = null;
    for (let current = directory; ; current = path.dirname(current)) {
      if (owners.has(current)) {
        root = owners.get(current);
        break;
      }
      visited.push(current);
      try {
        await lstat(path.join(current, ".git"));
        root = current;
        break;
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      }
      if (current === path.dirname(current)) break;
    }
    for (const visitedPath of visited) owners.set(visitedPath, root);
    return root;
  }
  for (const d of candidates.slice(0, maxDirectories)) {
    if (Date.now() > deadline) {
      complete = false;
      break;
    }
    try {
      const info = await lstat(d.path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        path.resolve(await realpath(d.path)).toLowerCase() !==
          path.resolve(d.path).toLowerCase()
      ) {
        skipped.push({
          path: d.path,
          reason: "Linked or unavailable directory.",
        });
        continue;
      }
      const root = await owner(d.path);
      checkedDirectories++;
      if (!root || root === d.path) continue;
      const list = groups.get(root) || [];
      list.push(d);
      groups.set(root, list);
    } catch (e) {
      skipped.push({ path: d.path, reason: e.message });
    }
  }
  if (
    candidates.length > maxDirectories ||
    checkedDirectories + skipped.length <
      Math.min(candidates.length, maxDirectories)
  )
    complete = false;
  const matches = [];
  for (const [root, directories] of groups) {
    if (Date.now() > deadline) {
      complete = false;
      break;
    }
    try {
      const actualRoot = (
        await git(root, "rev-parse", "--show-toplevel")
      ).trim();
      if (
        path.resolve(actualRoot).toLowerCase() !==
        path.resolve(root).toLowerCase()
      )
        throw new Error(
          "Repository ownership changed. Run the operation again.",
        );
      const ignored = await checkIgnores(
        root,
        directories.map(
          (d) => path.relative(root, d.path).split(path.sep).join("/") + "/",
        ),
      );
      const byPath = new Map(directories.map((d) => [path.resolve(d.path), d]));
      for (const rule of ignored) {
        const directory = byPath.get(path.resolve(root, rule.relative));
        if (directory)
          matches.push({
            ...directory,
            repository: root,
            ignore: {
              source: rule.source,
              line: rule.line,
              pattern: rule.pattern,
            },
          });
      }
    } catch (e) {
      errors.push({ path: root, reason: e.message });
      complete = false;
    }
  }
  // One row per outermost match, even across nested repository boundaries.
  const outermost = [];
  for (const match of matches.sort((a, b) => a.path.length - b.path.length)) {
    if (!outermost.some((parent) => within(match.path, parent.path)))
      outermost.push(match);
  }
  const targets = [];
  for (const match of outermost) {
    let cleanupSupported = false,
      reason =
        protectedReason(match.path) ||
        "Ignored by Git; review its contents and restoration steps before cleanup.";
    try {
      if (Date.now() > deadline) {
        complete = false;
        throw new Error(
          "Inspection budget reached. Run again with a narrower search area or higher threshold.",
        );
      }
      const tracked = await git(
        match.repository,
        "ls-files",
        "-z",
        "--",
        path.relative(match.repository, match.path),
      );
      if (tracked) reason = "Contains tracked files. Preserve project content.";
      else if (!protectedReason(match.path)) {
        const description = await describeGenerated(match.path);
        if (description) {
          cleanupSupported = true;
          reason = description.restore;
        }
      }
    } catch (e) {
      reason = "Cleanup evidence is unavailable: " + e.message;
    }
    targets.push({ ...match, cleanupSupported, reason });
  }
  return {
    scanId: report.id,
    recordedAt: report.completedAt,
    checkedAt: new Date().toISOString(),
    minimumBytes,
    targets: targets.sort(
      (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path),
    ),
    coverage: {
      complete: complete && skipped.length === 0,
      candidateCount: candidates.length,
      checkedDirectories,
      repositories: groups.size,
      directoryLimit: maxDirectories,
    },
    errors,
    skipped,
    notices: [
      "Git ignore rules were checked now; sizes are from the selected scan and may be dated or estimated.",
      "Only outermost matching folders are listed. Ignored files can include local settings, source assets and saved data; ignore status is not deletion permission.",
      "Logical file-entry sizes can count shared hardlinks more than once and do not guarantee physical free-space recovery.",
      ...(report.folderSizing?.estimated
        ? [
            "Quick scan skipped some descendants. Run a fresh folder totals scan for fuller coverage and current sizes.",
          ]
        : []),
      ...(!complete
        ? [
            "Git inspection was limited. Narrow the search area or raise the size threshold and run again.",
          ]
        : []),
    ],
  };
}
