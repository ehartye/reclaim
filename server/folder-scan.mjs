import { lstat, opendir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rollupFolderRows } from "./folder-accounting.mjs";

async function* windows(options, signal) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./windows-folder-totals.ps1", import.meta.url)),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let failure = "",
    finished = false;
  const cancel = () => child.kill();
  const done = new Promise((resolve) => {
    child.once("error", (e) => {
      failure = e.message;
      resolve(null);
    });
    child.once("close", resolve);
  });
  child.stderr.on("data", (b) => {
    failure = (failure + b.toString()).slice(0, 4000);
  });
  child.stdin.on("error", () => {});
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  child.stdin.end(JSON.stringify(options) + "\n");
  try {
    for await (const line of createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })) {
      if (signal?.aborted) break;
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "done") finished = true;
      else yield entry;
    }
    const code = await done;
    if (!signal?.aborted && (code !== 0 || !finished))
      throw new Error(failure || "Folder enumeration did not complete.");
  } finally {
    signal?.removeEventListener("abort", cancel);
    child.kill();
    await done;
  }
}
async function* portable(options, signal) {
  const pending = [options.root];
  const cache = new Map((options.folderCache || []).map((r) => [r.path, r]));
  const blocked = (p) =>
    options.exclusions.some((e) =>
      path.isAbsolute(e)
        ? p === e || p.startsWith(e + path.sep)
        : p.split(path.sep).includes(e),
    ) ||
    (options.skipCloud && p.split(path.sep).some((s) => /^OneDrive/i.test(s)));
  for (let p = options.root; ;) {
    if ((await lstat(p)).isSymbolicLink())
      throw new Error("Choose a real folder without linked ancestors.");
    const next = path.dirname(p);
    if (next === p) break;
    p = next;
  }
  while (pending.length && !signal?.aborted) {
    const dir = pending.pop();
    let directBytes = 0,
      directFiles = 0,
      complete = true,
      childCount = 0,
      hasGitFile = false;
    if (blocked(dir)) {
      yield {
        type: "skip",
        path: dir,
        reason: "Your exclusion or cloud setting",
      };
      continue;
    }
    const stat = await lstat(dir),
      stamp = Math.trunc(stat.mtimeMs),
      birthStamp = Math.trunc(stat.birthtimeMs),
      saved = cache.get(dir);
    if (saved && saved.stamp === stamp && saved.birthStamp === birthStamp) {
      yield {
        type: "directory",
        path: dir,
        directBytes: saved.bytes,
        directFiles: saved.fileCount,
        complete: true,
        estimated: true,
        stamp,
        birthStamp,
        childCount: 0,
        hasGitFile: saved.hasGitFile,
        measuredAt: saved.measuredAt,
        cachedDirectories: saved.directoryCount,
      };
      continue;
    }
    yield {
      type: "directory",
      path: dir,
      directBytes,
      directFiles,
      complete: false,
      stamp,
      birthStamp,
      childCount,
      hasGitFile,
    };
    try {
      if ((await lstat(dir)).isSymbolicLink())
        throw new Error("Filesystem link");
      for await (const entry of await opendir(dir)) {
        if (signal?.aborted) {
          complete = false;
          break;
        }
        const p = path.join(dir, entry.name);
        if (blocked(p) || entry.isSymbolicLink()) {
          yield { type: "skip", path: p, reason: "Excluded or linked entry" };
          complete = false;
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(p);
          childCount++;
        } else if (entry.isFile()) {
          try {
            directBytes += (await lstat(p)).size;
            directFiles++;
            if (entry.name === ".git") hasGitFile = true;
          } catch (e) {
            complete = false;
            yield { type: "error", path: p, reason: e.message };
          }
        }
        if (directFiles && directFiles % 1000 === 0)
          yield {
            type: "directory",
            path: dir,
            directBytes,
            directFiles,
            complete: false,
            stamp,
            birthStamp,
            childCount,
            hasGitFile,
          };
      }
    } catch (e) {
      complete = false;
      yield { type: "error", path: dir, reason: e.message };
    }
    yield {
      type: "directory",
      path: dir,
      directBytes,
      directFiles,
      complete,
      stamp,
      birthStamp,
      childCount,
      hasGitFile,
    };
  }
}
export async function scanFolderSizes(
  input,
  { signal, onProgress = () => {}, folderCache = [] } = {},
) {
  const options = {
    ...input,
    root: path.resolve(input.root),
    operation: "folder-sizes",
    duplicates: false,
    folderScanMode: input.folderScanMode || "quick",
    folderMinBytes: input.folderMinBytes ?? 500000000,
    exclusions: (input.exclusions || []).map((e) =>
      path.isAbsolute(e) ? path.resolve(e) : e.replace(/[\\/]+$/, ""),
    ),
  };
  delete options.maxDirectories;
  const eligible =
    options.folderScanMode === "fresh"
      ? []
      : folderCache.filter((r) => {
          const relative =
            typeof r.path === "string"
              ? path.relative(options.root, r.path)
              : "..";
          return (
            r.complete === true &&
            !r.estimated &&
            r.bytes <= options.folderMinBytes &&
            Number.isSafeInteger(r.bytes) &&
            r.bytes >= 0 &&
            Number.isSafeInteger(r.fileCount) &&
            r.fileCount >= 0 &&
            Number.isSafeInteger(r.directoryCount) &&
            r.directoryCount > 0 &&
            Number.isSafeInteger(r.stamp) &&
            Number.isSafeInteger(r.birthStamp) &&
            Number.isFinite(Date.parse(r.measuredAt)) &&
            Date.parse(r.measuredAt) <= Date.now() &&
            (relative === "" ||
              (!relative.startsWith("..") && !path.isAbsolute(relative)))
          );
        });
  const info = await lstat(options.root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Choose a regular folder.");
  const result = {
    id: randomUUID(),
    root: options.root,
    name: path.basename(options.root) || options.root,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: "",
    durationMs: 0,
    totalBytes: 0,
    opportunityBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    files: [],
    directories: [],
    findings: [],
    duplicateGroups: [],
    skipped: [],
    errors: [],
    notices: [
      "Folder sizes include all descendant file entries. Hardlinked names can count more than once; these logical totals are not physical deletion savings.",
      "Parent and child matches overlap. Do not add their sizes together.",
    ],
    options,
  };
  const dirs = new Map();
  const issues = [];
  let cacheDirectory;
  if (process.platform === "win32" && eligible.length) {
    cacheDirectory = await mkdtemp(
      path.join(tmpdir(), "reclaim-folder-cache-"),
    );
    options.cacheFile = path.join(cacheDirectory, "branches.tsv");
    await writeFile(
      options.cacheFile,
      eligible
        .filter((r) => !/[\t\r\n]/.test(r.path))
        .map((r) =>
          [
            r.path,
            r.bytes,
            r.fileCount,
            r.stamp,
            r.birthStamp,
            r.directoryCount,
            r.measuredAt,
            r.hasGitFile ? "1" : "0",
          ].join("\t"),
        )
        .join("\n"),
    );
  }
  let incomplete = false,
    lastProgress = 0;
  const emit = () => {
    if (Date.now() - lastProgress < 150) return;
    lastProgress = Date.now();
    onProgress({
      phase: "Counting folder totals",
      current: result.root,
      fileCount: result.fileCount,
      totalBytes: result.totalBytes,
      directoryCount: dirs.size,
    });
  };
  if (!signal?.aborted)
    try {
      for await (const entry of process.platform === "win32"
        ? windows(options, signal)
        : portable({ ...options, folderCache: eligible }, signal)) {
        if (entry.type === "directory") {
          if (
            !Number.isSafeInteger(entry.directBytes) ||
            entry.directBytes < 0 ||
            !Number.isSafeInteger(entry.directFiles) ||
            entry.directFiles < 0
          )
            throw new Error(
              "Folder metadata exceeds supported numeric precision.",
            );
          const previous = dirs.get(entry.path);
          result.totalBytes += entry.directBytes - (previous?.directBytes || 0);
          result.fileCount += entry.directFiles - (previous?.directFiles || 0);
          dirs.set(entry.path, {
            ...entry,
            bytes: entry.directBytes,
            fileCount: entry.directFiles,
          });
        } else {
          incomplete = true;
          issues.push(entry.path);
          if (entry.type === "limit") result.notices.push(entry.reason);
          else {
            const list = entry.type === "skip" ? result.skipped : result.errors;
            if (list.length < 1000)
              list.push({ path: entry.path, reason: entry.reason });
          }
        }
        emit();
        if (signal?.aborted) break;
      }
    } catch (e) {
      incomplete = true;
      result.errors.push({ path: options.root, reason: e.message });
    }
  if (cacheDirectory)
    await rm(cacheDirectory, { recursive: true, force: true });
  delete options.cacheFile;
  incomplete = rollupFolderRows(dirs, issues, result.startedAt) || incomplete;
  result.directories = [...dirs.values()].map((d) => ({
    path: d.path,
    bytes: d.bytes,
    fileCount: d.fileCount,
    complete: d.complete,
    estimated: Boolean(d.estimated),
    stamp: d.stamp,
    birthStamp: d.birthStamp,
    hasGitFile: Boolean(d.hasGitFile),
    directoryCount: d.directoryCount,
    measuredAt: d.measuredAt || result.startedAt,
  }));
  result.directoryCount = dirs.size;
  result.status = signal?.aborted
    ? "cancelled"
    : incomplete
      ? "partial"
      : "completed";
  result.completedAt = new Date().toISOString();
  result.durationMs =
    Date.parse(result.completedAt) - Date.parse(result.startedAt);
  result.folderSizing = {
    accountingVersion: 2,
    minimumBytes: options.folderMinBytes,
    basis: "logical-file-entries",
    scopeComplete: result.status === "completed",
    matchingCount: result.directories.filter(
      (d) => d.bytes > options.folderMinBytes,
    ).length,
    estimated: [...dirs.values()].some((d) => d.cachedDirectories > 0),
    cachedBranchCount: [...dirs.values()].filter((d) => d.cachedDirectories > 0)
      .length,
    prunedDirectoryCount: [...dirs.values()].reduce(
      (n, d) => n + (d.cachedDirectories || 0),
      0,
    ),
    visitedDirectoryCount: [...dirs.values()].filter(
      (d) => !d.cachedDirectories,
    ).length,
    freshFileCount: [...dirs.values()]
      .filter((d) => !d.cachedDirectories)
      .reduce((n, d) => n + d.directFiles, 0),
  };
  if (result.folderSizing.estimated) {
    result.folderSizing.cacheDate = new Date(
      [...dirs.values()].reduce(
        (oldest, d) =>
          d.cachedDirectories
            ? Math.min(oldest, Date.parse(d.measuredAt))
            : oldest,
        Infinity,
      ),
    ).toISOString();
    result.folderSizing.scopeComplete = false;
    if (result.status !== "cancelled") result.status = "partial";
    result.notices.push(
      "Quick scan reused dated small-branch totals and skipped their children. Descendants may have changed without changing this folder timestamp; use Fresh to recount every branch. Mixed totals are estimates, not lower bounds.",
    );
  }
  if (result.status !== "completed" && !result.folderSizing.estimated)
    result.notices.push(
      "Coverage is incomplete; folder totals are lower bounds for the entries counted. Unseen matches may remain.",
    );
  return result;
}
export async function inspectFolderFiles({
  root,
  exclusions = [],
  skipCloud = true,
  offset = 0,
  limit = 100,
}) {
  root = path.resolve(root);
  exclusions = exclusions.map((e) =>
    path.isAbsolute(e) ? path.resolve(e) : e.replace(/[\\/]+$/, ""),
  );
  if (
    exclusions.some((e) =>
      path.isAbsolute(e)
        ? root === e || root.startsWith(e + path.sep)
        : root.split(path.sep).includes(e),
    )
  )
    throw new Error("Your exclusion blocks this folder.");
  if (skipCloud && root.split(path.sep).some((s) => /^OneDrive/i.test(s)))
    throw new Error("Cloud folder excluded.");
  const files = [],
    notices = [];
  const signal = AbortSignal.timeout(15000);
  let nextOffset = null;
  if (process.platform === "win32") {
    for await (const entry of windows(
      {
        root,
        exclusions,
        skipCloud,
        offset,
        limit,
        inspect: true,
      },
      signal,
    )) {
      if (entry.type === "file")
        files.push({
          path: entry.path,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        });
      else if (entry.type === "page") nextOffset = entry.nextOffset;
      else if (notices.length < 20) notices.push(entry.reason);
    }
  } else {
    for (let p = root; ;) {
      if ((await lstat(p)).isSymbolicLink()) throw new Error("Linked ancestor");
      const next = path.dirname(p);
      if (next === p) break;
      p = next;
    }
    let seen = 0;
    const pending = [root];
    let more = false;
    while (pending.length && !more)
      for await (const entry of await opendir(pending.pop())) {
        if (signal.aborted) throw new Error("File inspection timed out.");
        if (entry.isSymbolicLink()) continue;
        const p = entry.parentPath
          ? path.join(entry.parentPath, entry.name)
          : path.join(root, entry.name);
        if (exclusions.some((e) => e === entry.name || e === p)) continue;
        if (skipCloud && /^OneDrive/i.test(entry.name)) continue;
        if (entry.isDirectory()) {
          pending.push(p);
          continue;
        }
        if (!entry.isFile()) continue;
        if (seen++ < offset) continue;
        if (files.length >= limit) {
          nextOffset = offset + files.length;
          more = true;
          break;
        }
        const stat = await lstat(p);
        files.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
      }
  }
  if (signal.aborted) throw new Error("File inspection timed out.");
  return { path: root, files, nextOffset, notices };
}
