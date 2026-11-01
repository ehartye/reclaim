import path from "node:path";
import { getRoutineDefinition, routineMode } from "./routine-policies.mjs";

// This module formats guidance from server-owned observations. It never launches
// tools. Request bodies must never be used as qualification observations.
const guides = {
  "unreal-ddc": [
    "Confirm the exact installed engine's selected graph, overrides and filesystem-DDC role using Epic's documentation. A familiar folder name is insufficient.",
    "Preserve source assets and close all cache consumers. Unknown layouts, nested Zen storage or foreign data require individual review.",
    "Follow version-matched owner documentation only. Reclaim supplies no DDC purge command; later asset and shader regeneration can be substantial.",
  ],
  "nvidia-shaders": [
    "Read NVIDIA's documented reset procedure and close games, editors and other shader-cache consumers.",
    "Using the NVIDIA controls yourself, disable shader caching and reboot as the procedure requires.",
    "Review and clear only the documented DXCache/GLCache contents and separately documented NV_Cache location. Never delete the NVIDIA parent.",
    "Restore the driver default and restart again. Subsequent games and applications rebuild shader data; this is an occasional reset/space procedure, not a performance guarantee.",
  ],
  "npm-cache": [
    "Resolve the configured cache using the selected installed npm executable; project dependencies and the npm parent are separate scopes.",
    "Close installations and cache consumers, and confirm required packages can be downloaded again, including private packages and offline work.",
    "npm cache verify is mutating maintenance: it verifies integrity and garbage-collects unneeded data. Its yield can be zero.",
    "Full clearing is a separate optional choice, not a corruption remedy required by default. It requires --force and can cause later downloads.",
  ],
  "npm-exec-cache": [
    "Use the installed version's npx-cache listing and information commands to review entries before choosing keys.",
    "Stop tools using those entries. Execution-cache entries may contain active application or agent runtimes.",
    "Remove only explicitly reviewed keys using npm's supported operation. Do not clear the entire npm cache parent or assume all execution entries are idle.",
  ],
  "pnpm-store": [
    "Resolve the active store with the selected installed pnpm version and check its version-matched prune documentation.",
    "Close installations and consumers. Pruning removes unreferenced packages; later branch changes or installs may need downloads, so preserve offline requirements.",
    "Current documented effects include expired execution-cache entries and package metadata. Global virtual-store collection is reference-aware; since v12.7, cleanup can also affect abandoned private pnpm/runtime copies.",
    "Run only the installed version's supported maintenance. Shared hardlinks and a store's logical size do not establish physical space recovery.",
  ],
  "pip-cache": [
    "Use the same already-installed Python interpreter for pip cache dir and pip cache info. Do not install a runtime merely to inspect a cache.",
    "The configured cache may differ from its default. A pip parent-directory total is not a measurement of the purgeable cache.",
    "After closing consumers and checking offline/download/build requirements, pip cache purge removes wheel and HTTP caches. Package-specific remove affects wheels, not the HTTP cache.",
    "Keep environments and source/configuration intact. Do not disable caching as a routine space-saving default.",
  ],
  "nuget-http-cache": [
    "Resolve the HTTP-cache location using the already-installed dotnet tool and its nuget locals list operation.",
    "Close consumers and check feed access and offline requirements before a separately chosen HTTP-cache clear.",
    "Global packages are excluded: projects use them directly. Never treat the .nuget parent as the HTTP cache or use old metadata timestamps as proof of non-use.",
  ],
  "gradle-cache": [
    "Review the installed Gradle version's cache-retention settings and existing cleanup behavior.",
    "Preserve user-home initialization scripts, credentials and configuration. Retention changes should follow the matching Gradle documentation.",
    "Do not recursively remove the Gradle user home or run project clean targets through Reclaim. Later builds may redownload or regenerate removed cached data.",
  ],
  "directx-shaders": [
    "Open Windows Storage/Disk Cleanup yourself and review the DirectX Shader Cache category.",
    "Close affected applications and inspect Windows' current category estimate before confirming removal there.",
    "Do not substitute a recursive directory purge. Shader data may regenerate on later launches.",
  ],
  "windows-temporary": [
    "Open Windows Storage cleanup yourself and review the temporary-data categories Windows identifies.",
    "Choose categories deliberately. Downloads, Recycle Bin and cloud offload have separate consequences and must not be silently selected.",
    "A partial Temp container total is not eligible capacity. Preserve active runtime/session data; never recursively purge Temp.",
  ],
  "unreal-zen": [
    "Keep Zen storage review-only while its reference-aware maintenance method is qualified separately.",
    "Zen can contain shared derived data and referenced cooked output. Do not remove Data, cache, cas or namespace directories directly.",
    "No safe purge command is established here. A successful documentation handoff is not a cleanup receipt.",
  ],
};

export function quotePowerShellArgument(value) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value))
    throw new Error("Use a single-line literal argument.");
  return "'" + value.replaceAll("'", "''") + "'";
}
const canonical = (value) => path.resolve(value).toLowerCase();
function localPath(value) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    !/[\0\r\n]/.test(value) &&
    !value.startsWith("\\\\") &&
    path.resolve(value) !== path.parse(path.resolve(value)).root &&
    !value.split(/[\\/]/).some((part) => /^OneDrive/i.test(part))
  );
}
function versionParts(value) {
  const match =
    typeof value === "string" && value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}
function nativeExecutable(value) {
  return localPath(value) && path.extname(value).toLowerCase() === ".exe";
}

function qualifiedScope(id, candidatePath, q) {
  if (
    !q ||
    typeof q !== "object" ||
    !localPath(candidatePath) ||
    q.source !== "installed-owner" ||
    q.pathChecked !== true ||
    q.documentationVersionMatches !== true ||
    q.activity !== "idle" ||
    typeof q.version !== "string" ||
    !/^\d+(?:\.\d+){1,3}$/.test(q.version) ||
    !localPath(q.resolvedPath)
  )
    return false;
  const direct = canonical(candidatePath) === canonical(q.resolvedPath);
  const version = versionParts(q.version);
  const capabilities = Array.isArray(q.capabilities) ? q.capabilities : [];
  if (id === "unreal-ddc")
    return (
      direct &&
      version?.[0] === 5 &&
      version[1] === 8 &&
      q.role === "filesystem-ddc" &&
      q.configurationComplete === true &&
      q.layoutRecognized === true &&
      q.mixedStore === false &&
      q.foreignData === false &&
      q.customLocation === false
    );
  if (["npm-cache", "npm-exec-cache"].includes(id))
    return (
      version?.[0] === 11 &&
      nativeExecutable(q.executable) &&
      path.basename(q.executable).toLowerCase() === "node.exe" &&
      localPath(q.npmCli) &&
      canonical(q.npmCli) ===
        canonical(
          path.join(
            path.dirname(q.executable),
            "node_modules/npm/bin/npm-cli.js",
          ),
        ) &&
      capabilities.includes(
        id === "npm-cache" ? "cache-verify" : "cache-npx",
      ) &&
      canonical(candidatePath) ===
        canonical(
          path.join(q.resolvedPath, id === "npm-cache" ? "_cacache" : "_npx"),
        )
    );
  if (id === "pnpm-store")
    return (
      direct &&
      version?.[0] === 12 &&
      version[1] >= 7 &&
      nativeExecutable(q.executable) &&
      path.basename(q.executable).toLowerCase() === "pnpm.exe" &&
      capabilities.includes("store-prune")
    );
  if (id === "pip-cache")
    return (
      direct &&
      version?.[0] === 26 &&
      version[1] === 2 &&
      nativeExecutable(q.executable) &&
      /^python(?:\d+(?:\.\d+)?)?\.exe$/i.test(path.basename(q.executable)) &&
      capabilities.includes("pip-cache")
    );
  if (id === "nuget-http-cache")
    return (
      direct &&
      [8, 9, 10].includes(version?.[0]) &&
      nativeExecutable(q.executable) &&
      path.basename(q.executable).toLowerCase() === "dotnet.exe" &&
      capabilities.includes("nuget-http-cache") &&
      q.role === "http-cache"
    );
  if (id === "gradle-cache")
    return (
      direct &&
      capabilities.includes("cache-retention") &&
      [8, 9].includes(version?.[0])
    );
  if (id === "nvidia-shaders")
    return (
      direct &&
      q.provider === "NVIDIA" &&
      ["dxcache", "glcache"].includes(
        path.basename(candidatePath).toLowerCase(),
      )
    );
  if (["directx-shaders", "windows-temporary"].includes(id))
    return direct && q.platform === "win32" && q.role === id;
  return false;
}

export function getRoutineGuide(
  routineId,
  { path: candidatePath, qualification } = {},
) {
  const definition = getRoutineDefinition(routineId);
  const qualified =
    definition.mode === "guided" &&
    qualifiedScope(routineId, candidatePath, qualification);
  const commands = [];
  const q = qualification;
  const add = (label, args, mutates, effects, optional = false) =>
    commands.push({
      label,
      command:
        "& " +
        quotePowerShellArgument(q.executable) +
        " " +
        [...(routineId.startsWith("npm-") ? [q.npmCli] : []), ...args]
          .map(quotePowerShellArgument)
          .join(" "),
      mutates,
      optional,
      scope: candidatePath,
      effects,
    });
  if (qualified && routineId === "npm-cache") {
    add(
      "Verify and garbage-collect npm cache",
      ["cache", "verify", "--cache", q.resolvedPath],
      true,
      "Changes the configured cache; removed data may need downloading again. Eligible bytes are unknown.",
    );
    add(
      "Optional full npm content-cache clear",
      ["cache", "clean", "--force", "--cache", q.resolvedPath],
      true,
      "Explicit optional full content-cache reset, not the separate execution cache. Check private-feed/offline needs first.",
      true,
    );
  }
  if (qualified && routineId === "npm-exec-cache") {
    add(
      "List execution-cache entries",
      ["cache", "npx", "ls", "--cache", q.resolvedPath],
      false,
      "Lists entries; it does not establish inactivity.",
    );
    const keys = q.selectedKeys;
    if (
      Array.isArray(keys) &&
      keys.length > 0 &&
      keys.length <= 20 &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          /^[a-f0-9]{8,64}$/i.test(key) &&
          q.listedKeys?.includes(key),
      )
    ) {
      add(
        "Inspect selected execution-cache entries",
        ["cache", "npx", "info", ...keys, "--cache", q.resolvedPath],
        false,
        "Review these exact keys before choosing removal.",
      );
      add(
        "Optional selected execution-cache removal",
        ["cache", "npx", "rm", ...keys, "--cache", q.resolvedPath],
        true,
        "Removes only the selected keys. Stop tools using them; later invocations may download packages again.",
        true,
      );
    }
  }
  if (qualified && routineId === "pnpm-store")
    add(
      "Prune unreferenced pnpm store data",
      ["store", "prune", "--store-dir", q.resolvedPath],
      true,
      "May also clean metadata, expired execution entries and version-specific global-store or abandoned runtime data. Future installs may redownload; logical bytes are not physical gain.",
    );
  if (qualified && routineId === "pip-cache") {
    add(
      "Inspect configured pip cache",
      ["-m", "pip", "cache", "info", "--cache-dir", q.resolvedPath],
      false,
      "Uses the same installed interpreter and exact configured cache.",
    );
    add(
      "Optional pip cache purge",
      ["-m", "pip", "cache", "purge", "--cache-dir", q.resolvedPath],
      true,
      "Clears HTTP and wheel caches only; later installs may download/build again.",
      true,
    );
  }
  if (qualified && routineId === "nuget-http-cache") {
    add(
      "List NuGet HTTP-cache location",
      ["nuget", "locals", "http-cache", "--list"],
      false,
      "Confirm the reported location still equals the reviewed scope before clearing.",
    );
    // NuGet has no per-command HTTP-cache directory argument. A copied clear
    // cannot pin this scope across configuration changes, so do not emit it.
  }
  return {
    title: definition.label,
    mode: routineMode(routineId, { guideQualified: qualified }),
    qualified,
    steps: [...(guides[routineId] || [definition.boundary])],
    commands,
    notices: [
      definition.boundary,
      "Reclaim never executes these maintenance commands or changes OS/driver settings. Manual completion is not verified deletion or measured space recovery.",
      ...(!qualified && definition.mode === "guided"
        ? [
            "Documentation only: exact installed-version, scope and inactive-consumer evidence is incomplete. No copyable maintenance command is supplied.",
          ]
        : []),
    ],
    evidence: [...definition.evidence],
  };
}
