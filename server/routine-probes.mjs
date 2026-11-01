import { lstat, realpath, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const inheritedKeys = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "ALLUSERSPROFILE",
  "PROGRAMDATA",
  "LANG",
  "LC_ALL",
  "TZ",
  "USERDOMAIN",
  "USERNAME",
  // Preserve location context, not arbitrary npm execution/logging options.
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_PREFIX",
]);
function probeEnvironment(inherited, scratch) {
  const environment = {};
  for (const [key, value] of Object.entries(inherited)) {
    const canonical = key.toUpperCase();
    if (inheritedKeys.has(canonical) && typeof value === "string")
      environment[canonical] = value;
  }
  return {
    ...environment,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_LOGS_DIR: scratch,
    NPM_CONFIG_LOGS_MAX: "10",
  };
}
async function normalPath(target, directory) {
  if (
    !path.isAbsolute(target) ||
    target.startsWith("\\\\") ||
    /[\0\r\n]/.test(target)
  )
    return false;
  for (let current = target; ; current = path.dirname(current)) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) return false;
    if (
      current === target &&
      (directory ? !entry.isDirectory() : !entry.isFile())
    )
      return false;
    if (current === path.dirname(current)) break;
  }
  return (
    path.resolve(await realpath(target)).toLowerCase() ===
    path.resolve(target).toLowerCase()
  );
}

// Fixed installed Node/npm probes only. A caller may inject fixtures for tests,
// but the production API must not expose these dependencies or accept command text.
export async function probeNpmGuides({
  nodePath = process.execPath,
  runFile = execute,
  checkPath = normalPath,
  inheritedEnvironment = process.env,
} = {}) {
  const notices = [],
    scopes = [];
  let scratch;
  try {
    const cli = path.join(
      path.dirname(nodePath),
      "node_modules/npm/bin/npm-cli.js",
    );
    if (!(await checkPath(nodePath, false)) || !(await checkPath(cli, false)))
      throw new Error("A trusted adjacent installed npm CLI is unavailable.");
    scratch = await mkdtemp(path.join(tmpdir(), "reclaim-npm-probe-"));
    const environment = probeEnvironment(inheritedEnvironment, scratch);
    const securityFlags = [
      "--offline=true",
      "--ignore-scripts=true",
      "--update-notifier=false",
      `--logs-dir=${scratch}`,
      "--logs-max=10",
    ];
    const options = {
      cwd: scratch,
      env: environment,
      windowsHide: true,
      shell: false,
      timeout: 4000,
      maxBuffer: 65536,
      encoding: "utf8",
    };
    const ask = async (args) => {
      let result;
      try {
        result = await runFile(
          nodePath,
          [cli, ...securityFlags, ...args],
          options,
        );
      } catch {
        throw new Error(
          "Installed npm probe failed or timed out; its configuration remains unverified.",
        );
      }
      return String(result.stdout || "").trim();
    };
    const version = await ask(["--version"]);
    if (!/^11\.\d+\.\d+$/.test(version))
      throw new Error(
        "Installed npm version is outside the captured v11 guide.",
      );
    const help = await ask(["cache", "--help"]);
    const cachePath = await ask(["config", "get", "cache", "--location=user"]);
    if (!(await checkPath(cachePath, true)))
      throw new Error("The configured cache is unavailable or linked.");
    const capabilities = [];
    if (/npm cache verify\b/.test(help)) capabilities.push("cache-verify");
    if (
      /npm cache npx ls\b/.test(help) &&
      /npm cache npx info\b/.test(help) &&
      /npm cache npx rm\b/.test(help)
    )
      capabilities.push("cache-npx");
    const qualification = {
      source: "installed-owner",
      executable: nodePath,
      npmCli: cli,
      version,
      resolvedPath: cachePath,
      documentationVersionMatches: true,
      capabilities,
      pathChecked: true,
      activity: "unknown",
    };
    for (const [routineId, child] of [
      ["npm-cache", "_cacache"],
      ["npm-exec-cache", "_npx"],
    ]) {
      const target = path.join(cachePath, child);
      if (!(await checkPath(target, true))) {
        notices.push(
          `${routineId}: resolved cache subtree is unavailable or linked.`,
        );
        continue;
      }
      scopes.push({
        routineId,
        path: target,
        qualification,
        guideQualified: false,
        reason:
          "Installed npm version, capabilities and configured scope were observed. Active consumers have not been excluded; documentation remains review-only.",
      });
    }
    notices.push(
      "Only installed npm version/help/configuration were inspected. No verification, pruning, removal, installation or consumer shutdown ran.",
    );
  } catch (error) {
    notices.push("npm guidance probe unavailable: " + error.message);
  } finally {
    if (scratch) {
      const resolved = path.resolve(scratch);
      const relative = path.relative(path.resolve(tmpdir()), resolved);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        path.basename(resolved).startsWith("reclaim-npm-probe-") &&
        (await normalPath(resolved, true))
      ) {
        await rm(resolved, { recursive: true, force: true }).catch(() =>
          notices.push("Temporary probe logs were retained."),
        );
      }
    }
  }
  return { scopes, notices };
}
