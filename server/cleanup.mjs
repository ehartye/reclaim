import {
  lstat,
  readdir,
  readFile,
  unlink,
  rmdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  describeGenerated,
  inspectWorktree,
  git,
  within,
} from "./project-discovery.mjs";
const fail = (message) => {
  throw Object.assign(new Error(message), { status: 409 });
};
const fingerprint = (st) =>
  [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode]
    .map(String)
    .join(":");
async function safeAncestors(target) {
  for (let p = target; ; p = path.dirname(p)) {
    const st = await lstat(p);
    if (st.isSymbolicLink())
      fail("Unsafe link or junction in the target path.");
    if (p === path.dirname(p)) break;
  }
  if (
    path.resolve(await realpath(target)).toLowerCase() !==
    path.resolve(target).toLowerCase()
  )
    fail("Unsafe linked target path.");
}
async function windowsCheck(target) {
  if (process.platform !== "win32") return;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-cleanup-check.ps1", import.meta.url)),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Safety inspection timed out. Narrow the target."));
    }, 60000);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString().slice(0, 2000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && stdout.trim() === "safe"
        ? resolve()
        : reject(
            new Error(
              "Unsafe link, offline/cloud object or incomplete Windows inspection: " +
                stderr.trim(),
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ path: target }) + "\n");
  });
}
async function inventory(target, kind = "generated") {
  await safeAncestors(target);
  await windowsCheck(target);
  const entries = [],
    pending = [target];
  let bytes = 0,
    fileCount = 0,
    hardlinkedBytes = 0;
  while (pending.length) {
    if (entries.length >= 250000)
      fail("Safety inspection limit reached. Choose a smaller folder.");
    const p = pending.pop();
    if (!within(p, target)) fail("Unsafe path outside target.");
    const st = await lstat(p, { bigint: true });
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
      fail("Unsafe link, junction or special file inside target.");
    if (
      path.basename(p).toLowerCase() === ".git" &&
      (st.isDirectory() || kind !== "worktree" || path.dirname(p) !== target)
    )
      fail("Nested Git repository requires manual review.");
    entries.push({
      path: p,
      directory: st.isDirectory(),
      fingerprint: fingerprint(st),
      size: st.isFile() ? Number(st.size) : 0,
    });
    if (st.isDirectory())
      for (const name of await readdir(p)) pending.push(path.join(p, name));
    else {
      bytes += Number(st.size);
      fileCount++;
      if (st.nlink > 1n) hardlinkedBytes += Number(st.size);
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries,
    bytes,
    fileCount,
    hardlinkedBytes,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}
async function evidence(target, kind) {
  if (kind === "worktree") {
    const status = await inspectWorktree(target);
    if (!status.eligible) fail(status.blockedReason);
    return {
      description: {
        path: target,
        kind,
        label: "Linked Git worktree",
        restore:
          "The branch is retained. Recreate a worktree from the preserved commit.",
        reason:
          "Git registration, local content and commit preservation verified.",
      },
      status,
    };
  }
  const description = await describeGenerated(target);
  if (!description)
    fail(
      "No recognized, restorable generated folder. Inspect the project manually.",
    );
  // A folder name/build script is never permission to discard tracked project content.
  let repo;
  try {
    repo = (await git(target, "rev-parse", "--show-toplevel")).trim();
  } catch (e) {
    if (!/not a git repository/i.test(e.stderr || "")) throw e;
  }
  if (
    repo &&
    (await git(repo, "ls-files", "-z", "--", path.relative(repo, target)))
      .length
  )
    fail("This folder contains tracked files. Preserve project content.");
  const parent = path.dirname(target),
    markers = [];
  for (const name of await readdir(parent))
    if (
      /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.toml|Cargo\.lock|requirements\.txt|pyproject\.toml|Pipfile|environment\.yml|project\.godot|Assets|ProjectSettings|Packages)$/i.test(
        name,
      ) ||
      /\.(csproj|fsproj|vbproj|uproject)$/i.test(name) ||
      (description.label === "Unreal project intermediates" &&
        name === "Source")
    ) {
      const p = path.join(parent, name);
      const st = await lstat(p, { bigint: true });
      if (st.isSymbolicLink())
        fail("Restoration evidence is a filesystem link.");
      markers.push([
        p,
        fingerprint(st),
        st.isFile()
          ? createHash("sha256")
              .update(await readFile(p))
              .digest("hex")
          : null,
      ]);
    }
  return { description, markers };
}
export function createCleanup({
  protectedPaths = [],
  onRecord = async () => {},
  now = Date.now,
} = {}) {
  const plans = new Map();
  let running = false;
  const protect = (target) => {
    if (
      !path.isAbsolute(target) ||
      target === path.parse(target).root ||
      target.toLowerCase() === homedir().toLowerCase() ||
      path.basename(target).toLowerCase() === ".git"
    )
      fail("Protected root cannot be deleted.");
    if (
      process.platform === "win32" &&
      (!/^[a-z]:[\\/]/i.test(target) ||
        target.split(path.sep).some((s) => /^OneDrive/i.test(s)))
    )
      fail("Network, device and cloud paths are protected.");
    if (
      protectedPaths.some(
        (p) =>
          within(target, path.resolve(p)) || within(path.resolve(p), target),
      )
    )
      fail("Protected application or data path cannot be deleted.");
    const system = [
      "Windows",
      "Program Files",
      "Program Files (x86)",
      "ProgramData",
      "System Volume Information",
      "$Recycle.Bin",
      "Recovery",
      "PerfLogs",
    ].map((n) => path.join(path.parse(target).root, n));
    if (process.platform === "win32" && system.some((p) => within(target, p)))
      fail("Protected system folder cannot be deleted.");
  };
  return {
    get running() {
      return running;
    },
    protectionReason(target) {
      try {
        protect(path.resolve(target));
        return null;
      } catch (e) {
        return e.message;
      }
    },
    async prepare(target, kind = "generated", context = {}) {
      target = path.resolve(target);
      protect(target);
      if (running) fail("Another cleanup is in progress.");
      if (kind !== "generated" && kind !== "worktree")
        fail("Unknown cleanup type.");
      const details = await evidence(target, kind),
        snapshot = await inventory(target, kind);
      if (!snapshot.entries[0]) fail("Inspection did not complete.");
      for (const [id, p] of plans) if (p.expiresAt <= now()) plans.delete(id);
      if (plans.size >= 20) plans.delete(plans.keys().next().value);
      const id = randomBytes(24).toString("hex"),
        phrase = "DELETE " + path.basename(target),
        expiresAt = now() + 5 * 60 * 1000;
      const preview = {
        id,
        path: target,
        kind,
        phrase,
        expiresAt,
        bytes: snapshot.bytes,
        fileCount: snapshot.fileCount,
        restore: details.description.restore,
        reason: details.description.reason,
        warnings: [
          "Permanent deletion bypasses the Recycle Bin. Close the owning application and active builds first.",
          "Logical file bytes are an estimate; actual disk space released can differ.",
          ...(snapshot.hardlinkedBytes
            ? [
                `${snapshot.hardlinkedBytes} bytes have other hardlinks and may release no storage.`,
              ]
            : []),
          ...(kind === "worktree"
            ? [
                "All files in this worktree, including verified generated ignored folders, will be removed. Its branch will remain.",
              ]
            : []),
        ],
      };
      plans.set(id, { ...preview, snapshot, details, context });
      return preview;
    },
    async execute(id, confirmation) {
      if (running) fail("Another cleanup is in progress.");
      const p = plans.get(id);
      if (!p || p.expiresAt <= now()) {
        plans.delete(id);
        fail("Preview expired or already used. Prepare a new preview.");
      }
      if (confirmation !== p.phrase) fail("Typed confirmation does not match.");
      plans.delete(id);
      running = true;
      const record = {
        id,
        kind: p.kind,
        path: p.path,
        startedAt: new Date(now()).toISOString(),
        status: "failed",
        deletedBytes: 0,
        deletedFiles: 0,
        ...p.context,
      };
      let gitAttempted = false;
      try {
        protect(p.path);
        const details = await evidence(p.path, p.kind),
          fresh = await inventory(p.path, p.kind);
        if (
          JSON.stringify(details) !== JSON.stringify(p.details) ||
          fresh.digest !== p.snapshot.digest
        )
          fail(
            "Target or restoration evidence changed. Prepare a new preview.",
          );
        // Persist intent before any deletion so a crash leaves an auditable uncertain result.
        await onRecord({ ...record, status: "started" });
        if (p.kind === "worktree") {
          gitAttempted = true;
          await git(
            p.details.status.mainPath,
            "worktree",
            "remove",
            "--",
            p.path,
          );
          try {
            await lstat(p.path);
            fail("Git removal left the directory present.");
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          record.deletedBytes = p.bytes;
          record.deletedFiles = p.fileCount;
        } else {
          const files = fresh.entries.filter((e) => !e.directory),
            dirs = fresh.entries
              .filter((e) => e.directory)
              .sort((a, b) => b.path.length - a.path.length);
          for (const entry of files) {
            await safeAncestors(path.dirname(entry.path));
            const st = await lstat(entry.path, { bigint: true });
            if (st.isSymbolicLink() || fingerprint(st) !== entry.fingerprint)
              fail("Target changed during cleanup; stopped.");
            await unlink(entry.path);
            record.deletedFiles++;
            record.deletedBytes += entry.size;
          }
          for (const entry of dirs) {
            await safeAncestors(entry.path);
            await rmdir(entry.path);
          }
        }
        record.status = "deleted";
      } catch (e) {
        if (gitAttempted) {
          for (const entry of p.snapshot.entries.filter((e) => !e.directory)) {
            try {
              await lstat(entry.path);
            } catch (statError) {
              if (statError.code === "ENOENT") {
                record.deletedFiles++;
                record.deletedBytes += entry.size;
              }
            }
          }
          record.status = "partial";
          record.error =
            "Git removal failed. Some files or Git registration may have been removed; inspect the target before retrying. " +
            e.message;
        } else {
          record.status = record.deletedFiles ? "partial" : "failed";
          record.error = e.message;
        }
      } finally {
        try {
          record.completedAt = new Date(now()).toISOString();
          await onRecord(record);
        } finally {
          running = false;
        }
      }
      return record;
    },
  };
}
