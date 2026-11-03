import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { productionProcessAdapter } from "./purge-processes.mjs";
import { validateSettings } from "../server/app.mjs";
import { loadRoutinePresets } from "../server/routine-presets.mjs";

const exec = promisify(execFile);
const TOOL = "reclaim-offline-result-purge",
  VERSION = 1,
  LIMIT = 16 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
class PurgeError extends Error {}
function fail(message) {
  throw new PurgeError(message);
}
function diagnostic(error) {
  if (error instanceof PurgeError) return error.message.slice(0, 1000);
  if (
    ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EIO", "EBUSY"].includes(
      error?.code,
    )
  )
    return `Filesystem operation failed (${error.code}).`;
  return "Purge operation failed; keep the service stopped and inspect the maintenance environment.";
}
function key(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return (
    !rel ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
function absolute(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0")
  )
    fail(`${label} must be an absolute path.`);
  if (
    process.platform === "win32" &&
    (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(":"))
  )
    fail(`${label} must be a local drive path without alternate streams.`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root)
    fail(`${label} cannot be a drive root.`);
  return resolved;
}
async function noLinks(target, { allowMissing = false } = {}) {
  let current = path.parse(target).root;
  for (const part of path
    .relative(current, target)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current, { bigint: true });
    } catch (error) {
      if (allowMissing && error.code === "ENOENT" && current === target)
        return null;
      throw error;
    }
    if (stat.isSymbolicLink())
      fail(`Link/reparse boundary refused: ${current}`);
    // realpath also catches junctions or aliases not represented as a normal file.
    if (key(await fs.realpath(current)) !== key(current))
      fail(`Reparse or aliased path refused: ${current}`);
  }
  return fs.lstat(target, { bigint: true });
}
async function nativeReparseCheck(files) {
  if (process.platform !== "win32") return;
  const paths = new Set();
  for (const file of files) {
    let current = file;
    while (!paths.has(current)) {
      paths.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const encoded = Buffer.from(JSON.stringify([...paths]), "utf8").toString(
    "base64",
  );
  const script = `$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); foreach ($p in $paths) { $item=Get-Item -LiteralPath $p -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse boundary refused.' } }`;
  try {
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
  } catch {
    fail("Native reparse boundary validation failed.");
  }
}
const identity = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  birthtimeNs: String(stat.birthtimeNs),
  uid: String(stat.uid),
  nlink: String(stat.nlink),
});
const fileIdentity = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  birthtimeNs: String(stat.birthtimeNs),
  uid: String(stat.uid),
});
async function boundedJson(file) {
  const stat = await noLinks(file);
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(LIMIT))
    fail("State or receipt is not a bounded, singly-linked regular file.");
  const handle = await fs.open(file, "r");
  try {
    if (
      canonical(identity(await handle.stat({ bigint: true }))) !==
      canonical(identity(stat))
    )
      fail("File changed while opening.");
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== Number(stat.size)) fail("File changed while reading.");
    if (
      canonical(identity(await handle.stat({ bigint: true }))) !==
      canonical(identity(stat))
    )
      fail("File changed while reading.");
    let value;
    try {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      fail("State, receipt or sanitized temporary file contains invalid JSON.");
    }
    return { value, stat };
  } finally {
    await handle.close();
  }
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function stateInfo(dataDir) {
  let result;
  try {
    result = await boundedJson(path.join(dataDir, "state.json"));
  } catch {
    fail("Saved state cannot be safely read.");
  }
  const state = result.value;
  if (
    !object(state) ||
    !object(state.settings) ||
    !Array.isArray(state.scans) ||
    !Array.isArray(state.cleanups) ||
    (state.reviews !== undefined && !object(state.reviews))
  )
    fail("Saved state has malformed fields; refusing to reconstruct defaults.");
  const settings = { ...state.settings };
  try {
    validateSettings(settings);
  } catch {
    fail("Saved state has malformed supported settings.");
  }
  // Loading checks the container and tolerates invalid individual presets. Its
  // normalized output is deliberately discarded so saved values remain exact.
  try {
    loadRoutinePresets(state.routines);
  } catch {
    fail("Saved state has a malformed routine preset container.");
  }
  for (const retired of [
    "minimumBytes",
    "largeFileBytes",
    "staleDays",
    "duplicates",
    "duplicateMinBytes",
    "hashBudgetBytes",
    "maxFiles",
    "opportunityAgeDays",
    "opportunityMinBytes",
  ])
    delete settings[retired];
  const sanitized = { ...state, settings, scans: [] };
  delete sanitized.reviews;
  const hashes = {};
  for (const field of Object.keys(sanitized).sort())
    if (field !== "scans") hashes[field] = digest(sanitized[field]);
  return {
    sanitized,
    hashes,
    originalHash: digest(state),
    sanitizedHash: digest(sanitized),
    identity: identity(result.stat),
  };
}
function classify(relative) {
  if (new RegExp(`^${UUID}\\.json$`, "i").test(relative)) return "report";
  if (
    ["activation-before.json", "ignored-folder-review.json"].includes(relative)
  )
    return "diagnostic-snapshot";
  if (relative === "state.tmp") return "state-write-temporary";
  if (new RegExp(`^intelligence/${UUID}\\.json$`, "i").test(relative))
    return "report-index";
  if (/^intelligence\/folders-[0-9a-f]{64}\.json$/i.test(relative))
    return "folder-cache";
  if (relative === "intelligence/measurements.json") return "measurements";
  if (
    relative === "intelligence/measurements.json.tmp" ||
    new RegExp(`^intelligence/${UUID}\\.${UUID}\\.tmp$`, "i").test(relative) ||
    new RegExp(
      `^intelligence/folders-[0-9a-f]{64}\\.json\\.${UUID}\\.tmp$`,
      "i",
    ).test(relative)
  )
    return "derived-write-temporary";
  return null;
}
async function enumerate(dataDir) {
  const targets = [],
    unknown = [];
  const visit = async (directory, prefix = "") => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = prefix + name,
        full = path.join(directory, name),
        stat = await fs.lstat(full, { bigint: true }),
        kind = classify(relative);
      if (relative === "state.json") continue;
      if (kind) {
        await noLinks(full);
        if (!stat.isFile() || stat.nlink !== 1n)
          fail(`Target must be a singly-linked regular file: ${relative}`);
        targets.push({
          path: relative,
          kind,
          originalSize: Number(stat.size),
          identity: identity(stat),
          outcome: "pending",
        });
      } else if (relative === "intelligence") {
        await noLinks(full);
        if (!stat.isDirectory()) fail("intelligence must be a real directory.");
        await visit(full, "intelligence/");
      } else
        unknown.push({
          path: relative,
          kind: stat.isSymbolicLink()
            ? "link-untouched"
            : stat.isDirectory()
              ? "directory-untouched"
              : "file-untouched",
        });
    }
  };
  await visit(dataDir);
  return { targets, unknown };
}
async function paths(options) {
  const dataDir = absolute(options.dataDir, "dataDir"),
    receipt = absolute(options.receipt, "receipt");
  if (inside(dataDir, receipt))
    fail("Receipt must be outside the data directory.");
  const stat = await noLinks(dataDir);
  if (!stat.isDirectory()) fail("dataDir must be a directory.");
  const parent = await noLinks(path.dirname(receipt));
  if (!parent.isDirectory()) fail("Receipt parent must be a directory.");
  return { dataDir, receipt, dataIdentity: fileIdentity(stat) };
}
async function protect(value, decrypt = false) {
  if (process.platform !== "win32")
    fail(
      "Receipt ownership requires Windows CurrentUser DPAPI; this platform is unsupported.",
    );
  const input = Buffer.from(value, "utf8").toString("base64");
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${input}'); $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser; $entropy=[Text.Encoding]::UTF8.GetBytes('${TOOL}/v${VERSION}'); ${decrypt ? "$out=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($b)),$entropy,$scope); [Text.Encoding]::UTF8.GetString($out)" : "$out=[System.Security.Cryptography.ProtectedData]::Protect($b,$entropy,$scope); [Convert]::ToBase64String($out)"}`;
  try {
    return (
      await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      )
    ).stdout.trim();
  } catch {
    fail(
      "Receipt ownership seal could not be validated for the current Windows user.",
    );
  }
}
function immutable(receipt) {
  return {
    tool: receipt.tool,
    version: receipt.version,
    id: receipt.id,
    dataDir: receipt.dataDir,
    dataIdentity: receipt.dataIdentity,
    receiptPath: receipt.receiptPath,
    owner: receipt.owner,
    buildCommit: receipt.buildCommit,
    startedAt: receipt.startedAt,
    targets: receipt.targets.map(({ path, kind, originalSize, identity }) => ({
      path,
      kind,
      originalSize,
      identity,
    })),
    preservedFieldHashes: receipt.preservedFieldHashes,
    originalStateHash: receipt.originalStateHash,
    sanitizedStateHash: receipt.sanitizedStateHash,
    stateIdentity: receipt.stateIdentity,
  };
}
async function writeReceipt(file, value, initial = false) {
  const temporary = initial ? file : file + "." + randomUUID() + ".tmp";
  await noLinks(path.dirname(file));
  if (!initial) await verifyReceipt(file, value.dataDir);
  const handle = await fs.open(temporary, "wx", 0o600);
  let written = false;
  try {
    value.receiptIdentity = fileIdentity(await handle.stat({ bigint: true }));
    value.seal = await protect(
      canonical({
        inventoryHash: digest(immutable(value)),
        receiptIdentity: value.receiptIdentity,
        owner: value.owner,
        receiptPath: file,
      }),
    );
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await fs.unlink(temporary).catch(() => {});
  }
  if (!initial) {
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
async function verifyReceipt(file, dataDir) {
  const { value, stat } = await boundedJson(file);
  if (
    !object(value) ||
    value.tool !== TOOL ||
    value.version !== VERSION ||
    value.dataDir !== dataDir ||
    value.receiptPath !== file ||
    value.owner !== userInfo().username ||
    !Array.isArray(value.targets) ||
    !["inventory", "partial", "complete", "refused"].includes(value.status)
  )
    fail("Not a matching tool-owned inventory receipt.");
  if (canonical(fileIdentity(stat)) !== canonical(value.receiptIdentity))
    fail("Receipt file identity changed.");
  const expected = canonical({
    inventoryHash: digest(immutable(value)),
    receiptIdentity: value.receiptIdentity,
    owner: value.owner,
    receiptPath: file,
  });
  if ((await protect(value.seal, true)) !== expected)
    fail("Receipt inventory or ownership seal changed.");
  const names = new Set();
  for (const target of value.targets) {
    if (
      !object(target) ||
      classify(target.path) !== target.kind ||
      !target.kind ||
      names.has(target.path) ||
      !["pending", "deleted", "missing", "failed"].includes(target.outcome)
    )
      fail("Receipt contains an invalid target.");
    names.add(target.path);
  }
  return value;
}
async function buildCommit() {
  return (
    await exec("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      windowsHide: true,
    })
  ).stdout.trim();
}
export async function inventory(options) {
  const location = await paths(options);
  if (await noLinks(location.receipt, { allowMissing: true }))
    fail("Receipt collision: output already exists.");
  const state = await stateInfo(location.dataDir),
    listing = await enumerate(location.dataDir);
  await nativeReparseCheck([
    location.dataDir,
    path.dirname(location.receipt),
    path.join(location.dataDir, "state.json"),
    ...listing.targets.map((target) =>
      path.join(location.dataDir, target.path),
    ),
  ]);
  const value = {
    tool: TOOL,
    version: VERSION,
    id: randomUUID(),
    mode: "inventory",
    status: "inventory",
    dataDir: location.dataDir,
    dataIdentity: location.dataIdentity,
    receiptPath: location.receipt,
    owner: userInfo().username,
    buildCommit: options.buildCommit || (await buildCommit()),
    targets: listing.targets,
    unknown: listing.unknown,
    originalTargetCount: listing.targets.length,
    remainingTargetCount: listing.targets.length,
    preservedFieldHashes: state.hashes,
    originalStateHash: state.originalHash,
    sanitizedStateHash: state.sanitizedHash,
    stateIdentity: state.identity,
    serviceExitEvidence: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errors: [],
  };
  await writeReceipt(location.receipt, value, true);
  return value;
}
async function reconcile(location, receipt) {
  const currentData = await noLinks(location.dataDir);
  if (canonical(fileIdentity(currentData)) !== canonical(receipt.dataIdentity))
    fail("Data directory identity changed.");
  const state = await stateInfo(location.dataDir);
  if (canonical(state.hashes) !== canonical(receipt.preservedFieldHashes))
    fail("Preserved state fields changed; create a fresh inventory.");
  if (
    ![receipt.originalStateHash, receipt.sanitizedStateHash].includes(
      state.originalHash,
    )
  )
    fail("State changed since inventory; create a fresh inventory.");
  if (
    state.originalHash === receipt.originalStateHash &&
    state.originalHash !== receipt.sanitizedStateHash &&
    canonical(state.identity) !== canonical(receipt.stateIdentity)
  )
    fail("Original state identity changed.");
  const listing = await enumerate(location.dataDir),
    original = new Map(receipt.targets.map((target) => [target.path, target]));
  await nativeReparseCheck([
    location.receipt,
    location.dataDir,
    path.join(location.dataDir, "state.json"),
    ...listing.targets.map((target) =>
      path.join(location.dataDir, target.path),
    ),
  ]);
  for (const target of listing.targets) {
    const old = original.get(target.path);
    if (!old) fail(`New target requires a fresh inventory: ${target.path}`);
    if (canonical(old.identity) !== canonical(target.identity))
      fail(`Target identity changed: ${target.path}`);
    if (["deleted", "missing"].includes(old.outcome))
      fail(`A completed target reappeared: ${target.path}`);
  }
  return {
    state,
    existing: new Set(listing.targets.map((target) => target.path)),
    unknown: listing.unknown,
  };
}
export async function applyPurge(options) {
  if (options.exclusiveMaintenance !== true)
    fail(
      "Apply requires --exclusive-maintenance and operator-controlled exclusive maintenance.",
    );
  const location = await paths(options),
    receipt = await verifyReceipt(location.receipt, location.dataDir);
  // Trusted dependency injection is available to disposable unit fixtures only; CLI has no adapter switch.
  const adapter = options.processAdapter || productionProcessAdapter;
  let checked;
  try {
    if (
      !(await adapter.validateEvidence(
        receipt.serviceExitEvidence,
        location.dataDir,
      ))
    )
      fail("Validated service exit evidence is required.");
    checked = await reconcile(location, receipt);
    const observation = await adapter.observe(
      location.dataDir,
      receipt.serviceExitEvidence,
    );
    if (
      !object(observation) ||
      !Array.isArray(observation.candidates) ||
      !Array.isArray(observation.ambiguous)
    )
      fail("Invalid process observation.");
    if (observation.ambiguous.length)
      fail("Ambiguous process ownership; maintenance refused.");
    if (observation.candidates.length)
      fail("A possible writer process remains; maintenance refused.");
  } catch (error) {
    receipt.mode = "apply";
    receipt.status = "refused";
    receipt.errors = [
      { at: new Date().toISOString(), message: diagnostic(error) },
    ];
    await writeReceipt(location.receipt, receipt);
    fail(diagnostic(error));
  }
  receipt.mode = "apply";
  receipt.status = "partial";
  receipt.errors = [];
  receipt.unknown = checked.unknown;
  receipt.lastProcessCheck = {
    at: new Date().toISOString(),
    candidateCount: 0,
    ambiguousCount: 0,
  };
  await writeReceipt(location.receipt, receipt);
  const io = { unlink: fs.unlink, rename: fs.rename, ...options.fileOps };
  let temporary;
  try {
    // Recheck after the receipt write, immediately before the first state mutation.
    const latest = await reconcile(location, receipt);
    if (latest.state.originalHash !== receipt.sanitizedStateHash) {
      const stateTemporary = path.join(
        location.dataDir,
        ".purge-sanitized-" + receipt.id + ".tmp",
      );
      if (await noLinks(stateTemporary, { allowMissing: true })) {
        const stale = await boundedJson(stateTemporary);
        if (digest(stale.value) !== receipt.sanitizedStateHash)
          fail(
            "Unexpected sanitized-state temporary file; refusing replacement.",
          );
        await nativeReparseCheck([stateTemporary]);
        await fs.unlink(stateTemporary);
      }
      const handle = await fs.open(stateTemporary, "wx", 0o600);
      temporary = stateTemporary;
      try {
        await handle.writeFile(canonical(latest.state.sanitized));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await noLinks(path.join(location.dataDir, "state.json"));
      await io.rename(temporary, path.join(location.dataDir, "state.json"));
      temporary = undefined;
    }
    const staleTemp = path.join(
      location.dataDir,
      ".purge-sanitized-" + receipt.id + ".tmp",
    );
    if (await noLinks(staleTemp, { allowMissing: true })) {
      const stale = await boundedJson(staleTemp);
      if (digest(stale.value) !== receipt.sanitizedStateHash)
        fail("Unexpected sanitized-state temporary file.");
      await nativeReparseCheck([staleTemp]);
      await fs.unlink(staleTemp);
    }
    for (const target of receipt.targets) {
      const full = path.join(location.dataDir, ...target.path.split("/"));
      if (
        !inside(location.dataDir, full) ||
        classify(target.path) !== target.kind
      )
        fail("Invalid target boundary.");
      const stat = await noLinks(full, { allowMissing: true });
      if (!stat) {
        if (target.outcome !== "deleted") target.outcome = "missing";
        continue;
      }
      if (canonical(identity(stat)) !== canonical(target.identity))
        fail(`Target changed before deletion: ${target.path}`);
      try {
        await io.unlink(full);
        target.outcome = "deleted";
      } catch (error) {
        target.outcome = "failed";
        throw error;
      }
    }
    const after = await stateInfo(location.dataDir);
    if (
      after.originalHash !== receipt.sanitizedStateHash ||
      canonical(after.hashes) !== canonical(receipt.preservedFieldHashes)
    )
      fail("Post-purge state preservation check failed.");
    const residual = await enumerate(location.dataDir);
    if (residual.targets.length)
      fail("Recognized result artifacts remain after purge.");
    receipt.unknown = residual.unknown;
    receipt.status = "complete";
    receipt.completedAt = new Date().toISOString();
  } catch (error) {
    receipt.status = "partial";
    receipt.errors.push({
      at: new Date().toISOString(),
      message: diagnostic(error),
    });
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
  receipt.remainingTargetCount = receipt.targets.filter(
    (target) => !["deleted", "missing"].includes(target.outcome),
  ).length;
  try {
    receipt.remainingTargetCount = (
      await enumerate(location.dataDir)
    ).targets.length;
  } catch (error) {
    receipt.remainingTargetCount = null;
    receipt.status = "partial";
    receipt.completedAt = null;
    receipt.errors.push({
      at: new Date().toISOString(),
      message: "Remaining targets could not be counted: " + diagnostic(error),
    });
  }
  await writeReceipt(location.receipt, receipt);
  return receipt;
}
function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" || arg === "--receipt") {
      const name = arg === "--data-dir" ? "dataDir" : "receipt";
      if (
        options[name] !== undefined ||
        !argv[i + 1] ||
        argv[i + 1].startsWith("--")
      )
        fail(`Missing or duplicate ${arg}.`);
      options[name] = argv[++i];
    } else if (arg === "--apply") options.apply = true;
    else if (arg === "--exclusive-maintenance")
      options.exclusiveMaintenance = true;
    else fail(`Unknown argument: ${arg}`);
  }
  return options;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = args(process.argv.slice(2));
    const result = options.apply
      ? await applyPurge(options)
      : await inventory(options);
    console.log(
      JSON.stringify({
        status: result.status,
        originalTargetCount: result.originalTargetCount,
        remainingTargetCount: result.remainingTargetCount,
        unknownCount: result.unknown.length,
        receipt: result.receiptPath,
      }),
    );
    if (result.status === "partial") process.exitCode = 1;
  } catch (error) {
    console.error(`Purge refused: ${diagnostic(error)}`);
    process.exitCode = 1;
  }
}
