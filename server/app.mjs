import http from "node:http";
import {
  containRequest,
  readRequestBody,
  requestUrl,
  sendJson,
  respondToError,
  httpTimeoutOptions,
} from "./http-boundary.mjs";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { openFolder } from "./reveal.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "./scanner.mjs";
import { runScanJob } from "./jobs.mjs";
import { normalizeRoots, git, parseWorktrees } from "./project-discovery.mjs";
import { createCleanup } from "./cleanup.mjs";
import { inspectFolderFiles } from "./folder-scan.mjs";
import { findIgnoredFolders } from "./ignored-folders.mjs";
import {
  routineDefinitions,
  getRoutineDefinition,
} from "./routine-policies.mjs";
import {
  defaultRoutinePreset,
  loadRoutinePresets,
  saveRoutinePreset,
  validateRoutinePreset,
} from "./routine-presets.mjs";
import {
  discoverRoutine,
  revalidateRoutineCandidate,
} from "./routine-discovery.mjs";
import { getRoutineGuide } from "./routine-guides.mjs";
import { probeNpmGuides } from "./routine-probes.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const csvCell = (value) =>
  '"' +
  String(value ?? "")
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';
const error = (message, status = 400) =>
  Object.assign(new Error(message), {
    status,
    publicCode: status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
  });

function validate(input, settings = false) {
  const out = {};
  if (!settings && input.folderScanMode !== undefined) {
    if (!["quick", "fresh"].includes(input.folderScanMode))
      throw error("Choose quick or fresh folder scanning.");
    out.folderScanMode = input.folderScanMode;
  }
  if (!settings && input.operation !== undefined) {
    if (input.operation !== "folder-sizes")
      throw error("Choose a supported scan operation.");
    out.operation = input.operation;
  }
  if (!settings) out.operation = "folder-sizes";
  if (input.developmentRoots !== undefined) {
    try {
      out.developmentRoots = normalizeRoots(input.developmentRoots);
    } catch (e) {
      throw error(e.message);
    }
  }
  const ranges = {
    folderMinBytes: [0, 1024 ** 5],
  };
  for (const [key, [min, max]] of Object.entries(ranges))
    if (input[key] !== undefined) {
      if (
        !Number.isSafeInteger(input[key]) ||
        input[key] < min ||
        input[key] > max
      )
        throw error(`Invalid ${key}.`);
      out[key] = input[key];
    }
  for (const key of ["skipCloud"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw error(`Invalid ${key}.`);
      out[key] = input[key];
    }
  if (input.exclusions !== undefined) {
    if (
      !Array.isArray(input.exclusions) ||
      input.exclusions.length > 100 ||
      input.exclusions.some(
        (e) => typeof e !== "string" || !e.trim() || e.length > 1000,
      )
    )
      throw error(
        "Use up to 100 folder names or absolute paths for exclusions.",
      );
    out.exclusions = input.exclusions.map((e) => e.trim());
  }
  if (!settings) {
    if (
      typeof input.root !== "string" ||
      !path.isAbsolute(input.root) ||
      input.root.length > 32000 ||
      input.root.includes("\0")
    )
      throw error("Enter an absolute folder path.");
    if (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(input.root))
      throw error(
        "Choose a local drive folder. Network and device paths are not supported.",
      );
    out.root = path.resolve(input.root);
  }
  return out;
}

// Maintenance validates stored preferences with the same constraints as the API.
// Callers may discard the normalized return value to preserve canonical values.
export function validateSettings(input) {
  return validate(input, true);
}

export async function createApp({
  dataDir = path.join(appRoot, ".reclaim"),
  dev = false,
  revealFolder = openFolder,
  routineProbe = probeNpmGuides,
  // Trusted embedding/test dependency only; HTTP bodies cannot replace cleanup.
  cleanupFactory = createCleanup,
  // Trusted embedding/test settings only; HTTP input cannot change deadlines.
  httpTimeouts,
} = {}) {
  const serverOptions = httpTimeoutOptions(httpTimeouts);
  await mkdir(dataDir, { recursive: true });
  let stored;
  try {
    stored = JSON.parse(
      await readFile(path.join(dataDir, "state.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const state = {
    settings: { ...defaults, ...validate(stored?.settings || {}, true) },
    scans: stored?.scans || [],
    cleanups: stored?.cleanups || [],
    routines: loadRoutinePresets(stored?.routines),
  };
  const token = randomBytes(32).toString("hex");
  let job = null;
  let writeChain = Promise.resolve();
  const save = () => {
    const body = JSON.stringify(state);
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await writeFile(path.join(dataDir, "state.tmp"), body);
        await rename(
          path.join(dataDir, "state.tmp"),
          path.join(dataDir, "state.json"),
        );
      });
    return writeChain;
  };
  const loadScan = async (id) => {
    if (!state.scans.some((s) => s.id === id))
      throw error("Scan not found.", 404);
    let report;
    try {
      report = JSON.parse(
        await readFile(path.join(dataDir, id + ".json"), "utf8"),
      );
    } catch (cause) {
      if (cause.code === "ENOENT")
        throw error(
          "Saved report is unavailable. Choose another scan or start a new scan.",
          404,
        );
      if (cause instanceof SyntaxError)
        throw error("Saved report is unreadable. Start a new folder scan.");
      throw cause;
    }
    if (
      !report?.folderSizing ||
      report.options?.operation !== "folder-sizes" ||
      report.folderSizing.accountingVersion !== 2 ||
      !Array.isArray(report.directories)
    )
      throw error(
        "This report format is unsupported. Start a new folder scan.",
      );
    return report;
  };
  let mainCheckout = appRoot;
  try {
    mainCheckout = parseWorktrees(
      await git(appRoot, "worktree", "list", "--porcelain", "-z"),
    )[0].worktree;
  } catch {}
  let cleanupBusy = false,
    cleanupIdle = Promise.resolve(),
    resolveCleanupIdle = () => {},
    closed = false;
  const cleanup = cleanupFactory({
    protectedPaths: [appRoot, mainCheckout, dataDir],
    onRecord: async (record) => {
      const index = state.cleanups.findIndex((r) => r.id === record.id);
      if (index >= 0) state.cleanups[index] = record;
      else state.cleanups.unshift(record);
      await save();
    },
  });
  const routineRuns = new Map();
  const settingsKey = () => JSON.stringify(state.settings);
  const routineInput = (operation) => {
    try {
      return operation();
    } catch (cause) {
      throw error(cause.message);
    }
  };
  const exactKeys = (value, allowed) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw error("Use only the supported routine parameters.");
  };
  const routineCatalog = () => ({
    definitions: routineDefinitions,
    presets: Object.fromEntries(
      routineDefinitions.map((definition) => [
        definition.id,
        state.routines.presets[definition.id] ||
          defaultRoutinePreset(definition.id, state.settings.developmentRoots),
      ]),
    ),
    invalidPresets: state.routines.invalidPresets,
  });
  const routineBusy = async (operation) => {
    if (job || cleanupBusy)
      throw error("Wait for the active scan or cleanup to finish.", 409);
    cleanupBusy = true;
    cleanupIdle = new Promise((resolve) => {
      resolveCleanupIdle = resolve;
    });
    try {
      return await operation();
    } finally {
      cleanupBusy = false;
      resolveCleanupIdle();
    }
  };
  const pruneRoutineRuns = () => {
    for (const [id, item] of routineRuns)
      if (item.expiresAt <= Date.now()) routineRuns.delete(id);
    while (routineRuns.size > 100)
      routineRuns.delete(routineRuns.keys().next().value);
  };
  const locations = [];
  for (const [label, target] of [
    ["Home", homedir()],
    ["Downloads", path.join(homedir(), "Downloads")],
    ["Documents", path.join(homedir(), "Documents")],
    ["Projects", path.join(homedir(), "repos")],
  ]) {
    try {
      if ((await lstat(target)).isDirectory())
        locations.push({ label, path: target });
    } catch {}
  }
  let vite;
  if (dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: appRoot,
      server: { middlewareMode: true },
      appType: "spa",
    });
  }
  const server = http.createServer(
    { ...serverOptions, maxHeaderSize: 16384 },
    containRequest(handleRequest),
  );
  async function handleRequest(req, res) {
    try {
      const port = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(req.headers.host)) {
        res.writeHead(403);
        res.end("Invalid host");
        return;
      }
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) {
        res.writeHead(403);
        res.end("Foreign origin refused");
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      const url = requestUrl(req.url, origin);
      const json = (data, status = 200) => sendJson(res, data, status);
      if (closed) throw error("Reclaim is shutting down.", 503);
      if (url.pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "GET" && url.pathname === "/api/state") {
          json({
            product: "reclaim",
            ...state,
            token,
            locations,
            cleanupBusy,
            job: job
              ? {
                  id: job.id,
                  root: job.root,
                  progress: job.progress,
                  error: job.error,
                }
              : null,
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/routines") {
          json(routineCatalog());
          return;
        }
        const match = url.pathname.match(
          /^\/api\/scans\/([a-f\d-]+)(?:\/(report\.(?:csv|json)))?$/,
        );
        if (req.method === "GET" && match) {
          const s = await loadScan(match[1]);
          if (match[2] === "report.csv") {
            const rows = [
              ["Folder path", "Recursive logical bytes", "Files", "Coverage"],
              ...s.directories
                .filter((d) => d.bytes > s.folderSizing.minimumBytes)
                .sort((a, b) => b.bytes - a.bytes)
                .map((d) => [
                  d.path,
                  d.bytes,
                  d.fileCount,
                  s.folderSizing.estimated
                    ? "Estimated mix of saved and current metadata"
                    : s.folderSizing.scopeComplete
                      ? "Complete for scan rules"
                      : "Partial lower bound",
                ]),
            ];
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="reclaim-folders.csv"',
            });
            res.end(
              "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"),
            );
            return;
          }
          if (match[2]) {
            res.setHeader(
              "Content-Disposition",
              'attachment; filename="reclaim-report.json"',
            );
            json({
              scan: s,
              sizeBasis: "Logical bytes, not measured allocated disk savings",
            });
            return;
          }
          json(s);
          return;
        }
        if (
          [
            "/api/development",
            "/api/development/quick",
            "/api/intelligence",
            "/api/intelligence/start",
            "/api/measurements/start",
            "/api/measurements/cancel",
            "/api/review",
          ].includes(url.pathname)
        )
          throw error("Endpoint not found.", 404);
        if (req.method !== "POST") throw error("Endpoint not found.", 404);
        if (req.headers["x-reclaim-token"] !== token)
          throw error("Session token missing. Reload the app.", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw error("Expected JSON.");
        const raw = await readRequestBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw error("Invalid JSON.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw error("Expected an object.");
        if (url.pathname === "/api/routines/presets") {
          await routineBusy(async () => {
            const next = routineInput(() =>
              saveRoutinePreset(state.routines, body, {
                roots: state.settings.developmentRoots,
              }),
            );
            state.routines = next;
            for (const [id, item] of routineRuns)
              if (item.run.routineId === body.routineId) routineRuns.delete(id);
            await save();
          });
          json(routineCatalog());
          return;
        }
        if (url.pathname === "/api/routines/run") {
          exactKeys(body, ["routineId", "parameters", "scanId"]);
          const definition = routineInput(() =>
            getRoutineDefinition(body.routineId),
          );
          if (body.parameters !== undefined)
            exactKeys(body.parameters, [
              "minimumBytes",
              "minimumAgeDays",
              "roots",
              "policyVersion",
            ]);
          if (body.scanId !== undefined && typeof body.scanId !== "string")
            throw error("Choose a known scan.");
          const run = await routineBusy(async () => {
            const started = Date.now(),
              initialSettings = settingsKey();
            const settings = structuredClone(state.settings);
            const saved = state.routines.presets[definition.id];
            if (
              !saved &&
              state.routines.invalidPresets[definition.id] &&
              body.parameters === undefined
            )
              throw error(
                "Correct and save this routine's invalid preset before running.",
              );
            const parameters = routineInput(() =>
              validateRoutinePreset({
                ...(saved ||
                  defaultRoutinePreset(
                    definition.id,
                    settings.developmentRoots,
                  )),
                ...(body.parameters || {}),
                routineId: definition.id,
              }),
            );
            const report =
              body.scanId === undefined
                ? undefined
                : await loadScan(body.scanId);
            const probe = definition.id.startsWith("npm-")
              ? await routineProbe()
              : { scopes: [], notices: [] };
            const remaining = 30000 - (Date.now() - started);
            if (remaining <= 0)
              throw error(
                "Routine discovery budget elapsed. Narrow the scope and run again.",
                409,
              );
            const run = await discoverRoutine({
              routineId: definition.id,
              parameters,
              report,
              settings,
              protectedReason: cleanup.protectionReason,
              budgetMs: remaining,
              ...(definition.id.startsWith("npm-") && probe.scopes.length
                ? {
                    guideScopes: probe.scopes.filter(
                      (scope) => scope.routineId === definition.id,
                    ),
                  }
                : {}),
              guideForCandidate: (routineId, target, scope) =>
                getRoutineGuide(routineId, {
                  path: target,
                  qualification: scope.qualification,
                }),
            });
            if (closed || settingsKey() !== initialSettings)
              throw error(
                "Settings changed during discovery. Run the routine again.",
                409,
              );
            run.notices.push(...probe.notices);
            pruneRoutineRuns();
            routineRuns.set(run.id, { run, expiresAt: Date.now() + 300000 });
            pruneRoutineRuns();
            return run;
          });
          json(run);
          return;
        }
        if (url.pathname === "/api/routines/candidates/prepare") {
          exactKeys(body, ["runId", "candidateId"]);
          if (
            typeof body.runId !== "string" ||
            typeof body.candidateId !== "string"
          )
            throw error("Choose a known routine candidate.");
          const preview = await routineBusy(async () => {
            pruneRoutineRuns();
            const known = routineRuns.get(body.runId);
            if (!known)
              throw error(
                "Routine evidence is stale or unknown. Run the routine again.",
                409,
              );
            const initialSettings = settingsKey();
            let target;
            try {
              target = await revalidateRoutineCandidate(
                known.run,
                body.candidateId,
                {
                  settings: state.settings,
                  protectedReason: cleanup.protectionReason,
                },
              );
            } catch (cause) {
              throw error(cause.message, 409);
            }
            if (settingsKey() !== initialSettings)
              throw error("Settings changed. Run the routine again.", 409);
            const preview = await cleanup.prepare(
              target.path,
              target.kind,
              target.context,
            );
            if (settingsKey() !== initialSettings)
              throw error(
                "Settings changed during preparation. Run the routine again.",
                409,
              );
            return preview;
          });
          json(preview);
          return;
        }
        if (url.pathname === "/api/folders/ignored") {
          if (
            !Number.isSafeInteger(body.minimumBytes) ||
            body.minimumBytes < 0 ||
            body.minimumBytes > 1024 ** 5
          )
            throw error("Choose a valid folder size threshold.");
          const report = await loadScan(body.scanId);
          json(
            await findIgnoredFolders(report, body.minimumBytes, {
              exclusions: [
                ...report.options.exclusions,
                ...state.settings.exclusions,
              ],
              skipCloud: state.settings.skipCloud || report.options.skipCloud,
              protectedReason: cleanup.protectionReason,
            }),
          );
          return;
        }
        if (url.pathname === "/api/folders/inspect") {
          if (typeof body.path !== "string" || !path.isAbsolute(body.path))
            throw error("Choose a known folder.");
          const report = await loadScan(body.scanId),
            target = path.resolve(body.path);
          if (!report.directories.some((d) => d.path === target))
            throw error("Choose a folder in this saved scan.");
          const offset = body.offset ?? 0,
            limit = body.limit ?? 100;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > 2147483647 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 200
          )
            throw error("Use a valid file page (up to200 entries).");
          const listing = await inspectFolderFiles({
            root: target,
            offset,
            limit,
            exclusions: [
              ...new Set([
                ...report.options.exclusions,
                ...state.settings.exclusions,
              ]),
            ],
            skipCloud: state.settings.skipCloud || report.options.skipCloud,
          });
          json(listing);
          return;
        }
        if (url.pathname === "/api/scans") {
          const options = { ...state.settings, ...validate(body) };
          if (job || cleanupBusy)
            throw error("A scan or cleanup is already running.", 409);
          let info;
          try {
            info = await lstat(options.root);
          } catch {
            throw error("Folder not found or inaccessible.");
          }
          if (!info.isDirectory() || info.isSymbolicLink())
            throw error("Choose a regular folder.");
          // Filesystem validation yields; another request may have started a scan meanwhile.
          if (job || cleanupBusy)
            throw error("A scan or cleanup is already running.", 409);
          const controller = new AbortController();
          const current = {
            id: randomBytes(8).toString("hex"),
            root: options.root,
            controller,
            progress: {
              phase: "Starting scan",
              fileCount: 0,
              totalBytes: 0,
              current: options.root,
            },
          };
          job = current;
          delete state.lastError;
          current.promise = (async () => {
            try {
              const summary = await runScanJob({
                options,
                dataDir,
                signal: controller.signal,
                onProgress: (p) => {
                  current.progress = p;
                },
              });
              state.scans.unshift(summary);
              await save();
            } catch (e) {
              current.error = e.message;
              state.lastError = e.message;
              try {
                await save();
              } catch (persistError) {
                state.lastError = `${e.message} History could not be saved: ${persistError.message}`;
              }
            } finally {
              job = null;
            }
          })();
          json({ id: current.id }, 202);
          return;
        }
        if (url.pathname === "/api/cancel") {
          job?.controller.abort();
          json({ ok: true });
          return;
        }
        if (url.pathname === "/api/settings") {
          if (cleanupBusy)
            throw error("Wait for the cleanup inspection to finish.", 409);
          state.settings = { ...state.settings, ...validate(body, true) };
          routineRuns.clear();
          await save();
          json(state.settings);
          return;
        }
        if (
          url.pathname === "/api/cleanup/prepare" ||
          url.pathname === "/api/cleanup/execute"
        ) {
          if (job || cleanupBusy)
            throw error("Wait for the active scan or cleanup to finish.", 409);
          cleanupBusy = true;
          cleanupIdle = new Promise((resolve) => {
            resolveCleanupIdle = resolve;
          });
          try {
            if (url.pathname.endsWith("/execute")) {
              const result = await cleanup.execute(body.id, body.confirmation);
              json(result);
              return;
            }
            if (body.targetId !== undefined || body.findingId !== undefined)
              throw error(
                "Legacy target and finding preparation are unsupported. Choose a saved folder or routine.",
              );
            let target,
              kind = "generated",
              context = {};
            if (
              typeof body.scanId === "string" &&
              typeof body.directoryPath === "string"
            ) {
              const report = await loadScan(body.scanId),
                resolved = path.resolve(body.directoryPath),
                known = report.directories.find((d) => d.path === resolved);
              if (!known) throw error("Choose a folder in this saved scan.");
              target = known.path;
              kind = "generated";
              try {
                if ((await lstat(path.join(target, ".git"))).isFile())
                  kind = "worktree";
              } catch (e) {
                if (e.code !== "ENOENT") throw e;
              }
              context = { scanId: report.id };
            } else
              throw error(
                "Choose a folder in a saved scan or use routine preparation.",
              );
            const preview = await cleanup.prepare(target, kind, context);
            json(preview);
            return;
          } finally {
            cleanupBusy = false;
            resolveCleanupIdle();
          }
        }
        if (url.pathname === "/api/shutdown") {
          if (job || cleanupBusy)
            throw error(
              "Finish active scans and cleanup before closing Reclaim.",
              409,
            );
          json({ ok: true });
          void closeApp();
          return;
        }
        if (url.pathname === "/api/reveal") {
          const s = await loadScan(body.scanId);
          const known = new Set([s.root, ...s.directories.map((f) => f.path)]);
          if (typeof body.path !== "string" || !known.has(body.path))
            throw error("Choose a path from this scan.");
          let target = path.resolve(body.path);
          const info = await lstat(target);
          if (info.isSymbolicLink())
            throw error("Path has become a filesystem link. Rescan it.");
          if (!info.isDirectory()) target = path.dirname(target);
          await revealFolder(target);
          json({ ok: true, folder: target });
          return;
        }
        throw error("Endpoint not found.", 404);
      }
      if (vite) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            res.off("finish", done);
            res.off("close", done);
          };
          const done = () => {
            cleanup();
            resolve();
          };
          res.once("finish", done);
          res.once("close", done);
          try {
            vite.middlewares(req, res, (cause) => {
              if (cause) {
                cleanup();
                reject(cause);
                return;
              }
              try {
                if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                  res.writeHead(404);
                  res.end();
                }
              } catch (failure) {
                cleanup();
                reject(failure);
              }
            });
          } catch (cause) {
            res.off("finish", done);
            res.off("close", done);
            reject(cause);
          }
        });
        return;
      }
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let target = path.resolve(appRoot, "dist", relative || "index.html");
      if (!target.startsWith(path.join(appRoot, "dist") + path.sep))
        throw error("Not found.", 404);
      let contents;
      try {
        contents = await readFile(target);
      } catch {
        target = path.join(appRoot, "dist", "index.html");
        contents = await readFile(target);
      }
      const mime = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, {
        "Content-Type":
          mime[path.extname(target)] || "application/octet-stream",
      });
      res.end(contents);
    } catch (cause) {
      respondToError(req, res, cause);
    }
  }
  async function closeApp() {
    if (closed) return;
    closed = true;
    job?.controller.abort();
    try {
      await job?.promise;
      await cleanupIdle;
      await writeChain;
    } finally {
      await vite?.close();
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    }
  }
  return {
    server,
    state,
    close: closeApp,
  };
}
