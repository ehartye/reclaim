import { readdir, lstat, realpath, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { analyze, selectedBytes } from "./analysis.mjs";
import { scanFolderSizes } from "./folder-scan.mjs";

export const defaults = {
  minimumBytes: 1024 * 1024,
  largeFileBytes: 100 * 1024 * 1024,
  staleDays: 90,
  opportunityAgeDays: 30,
  opportunityMinBytes: 100 * 1024 ** 2,
  duplicates: false,
  duplicateMinBytes: 1024 * 1024,
  hashBudgetBytes: 1024 ** 3,
  maxFiles: 250000,
  exclusions: [],
  skipCloud: true,
  developmentRoots: [path.join(homedir(), "repos")],
};

async function* enumerate(options, signal) {
  if (process.platform === "win32") {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-enumerate.ps1", import.meta.url)),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    let failure;
    child.stderr.on("data", (b) => {
      stderr += b.toString().slice(0, 2000);
    });
    const done = new Promise((resolve) => {
      child.on("error", (e) => {
        failure = e;
        resolve(null);
      });
      child.on("close", resolve);
    });
    const cancel = () => child.kill();
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(options) + "\n");
    try {
      for await (const line of createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })) {
        if (signal?.aborted) break;
        if (line.trim()) yield JSON.parse(line);
      }
      const code = await done;
      if (!signal?.aborted && (failure || code !== 0))
        throw (
          failure || new Error(stderr || "Windows metadata enumeration failed")
        );
    } finally {
      signal?.removeEventListener("abort", cancel);
      child.kill();
    }
    return;
  }
  const pending = [options.root];
  while (pending.length && !signal?.aborted) {
    const target = pending.pop();
    if (
      options.exclusions.some(
        (e) =>
          target === e ||
          target.startsWith(e + path.sep) ||
          target.split(path.sep).includes(e),
      )
    ) {
      yield { type: "skip", path: target, reason: "Your exclusion" };
      continue;
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        yield { type: "skip", path: target, reason: "Filesystem link" };
        continue;
      }
      if (info.isDirectory()) {
        yield { type: "directory", path: target };
        for (const e of await readdir(target))
          pending.push(path.join(target, e));
      } else if (info.isFile()) yield { type: "file", path: target };
    } catch (e) {
      yield { type: "error", path: target, reason: e.message };
    }
  }
}

async function verifyHash(file, signal) {
  if (signal?.aborted) return null;
  const before = await lstat(file.path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink > 1n ||
    before.size !== BigInt(file.size) ||
    before.mtimeNs.toString() !== file.mtimeNs
  )
    return null;
  const handle = await open(file.path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size
    )
      return null;
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (signal?.aborted) return null;
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      return null;
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function scan(
  input,
  { signal, onProgress = () => {}, folderCache = [] } = {},
) {
  if (input.operation === "folder-sizes")
    return scanFolderSizes(
      { ...defaults, ...input },
      { signal, onProgress, folderCache },
    );
  const options = { ...defaults, ...input, root: path.resolve(input.root) };
  options.exclusions = options.exclusions.map((e) =>
    path.isAbsolute(e) ? path.resolve(e) : e.replace(/[\\/]+$/, ""),
  );
  const rootInfo = await lstat(options.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Choose a regular folder, not a file or filesystem link.");
  if (
    (await realpath(options.root)) !== options.root &&
    process.platform !== "win32"
  )
    throw new Error("Choose the real folder path.");
  const result = {
    id: randomUUID(),
    root: options.root,
    name: path.basename(options.root) || options.root,
    status: "running",
    startedAt: new Date().toISOString(),
    totalBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    files: [],
    directories: [],
    findings: [],
    duplicateGroups: [],
    skipped: [],
    errors: [],
    notices: [],
    options,
  };
  const identities = new Set();
  let lastProgress = 0;
  const report = (phase, current) => {
    if (Date.now() - lastProgress > 150) {
      onProgress({
        phase,
        current,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
      });
      lastProgress = Date.now();
    }
  };
  if (!signal?.aborted)
    for await (const entry of enumerate(options, signal)) {
      if (signal?.aborted) break;
      if (entry.type === "directory") {
        result.directories.push({ path: entry.path, bytes: 0, fileCount: 0 });
        result.directoryCount++;
      } else if (entry.type === "file") {
        try {
          const stat = await lstat(entry.path, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const identity = `${stat.dev}:${stat.ino}`;
          if (identities.has(identity)) {
            if (result.skipped.length < 1000)
              result.skipped.push({
                path: entry.path,
                reason: "Hardlink already counted",
              });
            continue;
          }
          identities.add(identity);
          const size = Number(stat.size);
          result.files.push({
            path: entry.path,
            size,
            mtimeMs: Number(stat.mtimeNs) / 1e6,
            mtimeNs: stat.mtimeNs.toString(),
            nlink: Number(stat.nlink),
            identity,
          });
          result.totalBytes += size;
          result.fileCount++;
        } catch (e) {
          if (result.errors.length < 1000)
            result.errors.push({ path: entry.path, reason: e.message });
        }
        if (result.fileCount >= options.maxFiles) {
          result.notices.push(
            `File limit of ${options.maxFiles.toLocaleString()} reached. Narrow the scan for full coverage.`,
          );
          result.status = "partial";
          break;
        }
      } else if (entry.type === "skip") {
        if (result.skipped.length < 1000) result.skipped.push(entry);
      } else if (entry.type === "error") {
        if (result.errors.length < 1000) result.errors.push(entry);
      }
      report("Scanning folders", entry.path);
    }
  const dirMap = new Map(result.directories.map((d) => [d.path, d]));
  onProgress({
    phase: "Summarizing folders",
    current: options.root,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
  });
  for (const file of result.files) {
    let parent = path.dirname(file.path);
    while (dirMap.has(parent)) {
      const d = dirMap.get(parent);
      d.bytes += file.size;
      d.fileCount++;
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  if (options.duplicates && !signal?.aborted) {
    const bySize = new Map();
    for (const file of result.files.filter(
      (f) => f.size >= options.duplicateMinBytes && f.nlink === 1,
    )) {
      const group = bySize.get(file.size) || [];
      group.push(file);
      bySize.set(file.size, group);
    }
    let used = 0,
      budgetNotice = false;
    const eligible = [...bySize.values()].filter((g) => g.length > 1);
    const safe = new Set();
    if (process.platform === "win32" && eligible.length) {
      for await (const entry of enumerate(
        { ...options, filePaths: eligible.flat().map((f) => f.path) },
        signal,
      )) {
        if (entry.type === "file") safe.add(entry.path);
        else if (entry.type === "error" && result.errors.length < 1000)
          result.errors.push(entry);
        else if (entry.type === "skip" && result.skipped.length < 1000)
          result.skipped.push(entry);
      }
    }
    for (const candidates of eligible) {
      if (candidates.length < 2) continue;
      const size = candidates.reduce((n, f) => n + f.size, 0);
      if (used + size > options.hashBudgetBytes) {
        budgetNotice = true;
        continue;
      }
      const hashes = new Map();
      for (const file of candidates) {
        if (signal?.aborted) break;
        if (process.platform === "win32" && !safe.has(file.path)) continue;
        try {
          used += file.size;
          if (used === file.size) {
            onProgress({
              phase: "Verifying duplicates",
              current: file.path,
              fileCount: result.fileCount,
              totalBytes: result.totalBytes,
            });
            lastProgress = Date.now();
          } else report("Verifying duplicates", file.path);
          const hash = await verifyHash(file, signal);
          if (!hash) continue;
          const members = hashes.get(hash) || [];
          members.push(file);
          hashes.set(hash, members);
        } catch (e) {
          if (result.errors.length < 1000)
            result.errors.push({
              path: file.path,
              reason: `Hash skipped: ${e.message}`,
            });
        }
      }
      for (const [hash, files] of hashes)
        if (files.length > 1)
          result.duplicateGroups.push({
            id: hash,
            hash,
            files: files.sort((a, b) => a.path.localeCompare(b.path)),
            bytes: (files.length - 1) * files[0].size,
          });
    }
    if (budgetNotice)
      result.notices.push(
        "Hash budget reached; some same-size files were not verified. Increase the budget or scan a smaller folder.",
      );
  }
  if (signal?.aborted) result.status = "cancelled";
  else if (result.status !== "partial")
    result.status = result.errors.length ? "partial" : "completed";
  onProgress({
    phase: "Ranking opportunities",
    current: options.root,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
  });
  result.findings = analyze(
    result.files,
    result.directories,
    options,
    result.duplicateGroups,
    () => signal?.aborted,
  );
  if (signal?.aborted) result.status = "cancelled";
  result.opportunityBytes = selectedBytes(
    result.findings,
    result.findings.map((f) => f.id),
    result.files,
  );
  result.completedAt = new Date().toISOString();
  result.durationMs = Date.now() - Date.parse(result.startedAt);
  return result;
}
