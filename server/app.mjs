import http from "node:http";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { openFolder } from "./reveal.mjs";
import {
  normalizeReview,
  reviewStatus,
  dispositionReview,
} from "../shared/review.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "./scanner.mjs";
import { runScanJob } from "./jobs.mjs";
import {
  normalizeRoots,
  discoverDevelopment,
  git,
  parseWorktrees,
  discoveryOperations,
  within,
  describeDiscoveryTarget,
} from "./development.mjs";
import { createCleanup } from "./cleanup.mjs";
import { enrichFindings } from "./insights.mjs";
import {
  createOpportunityIndex,
  loadReportIndex,
} from "./opportunity-index.mjs";
import { createMeasurementJobs } from "./opportunity-jobs.mjs";
import { probeActivity } from "./opportunity-advice.mjs";
import { latestChange } from "../shared/opportunities.ts";
import { inspectFolderFiles } from "./folder-scan.mjs";
import { normalizeFolderReport } from "./folder-accounting.mjs";
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
  Object.assign(new Error(message), { status });

function validate(input, settings = false) {
  const out = {};
  if (!settings && input.folderScanMode !== undefined) {
    if (!["quick", "fresh"].includes(input.folderScanMode))
      throw error("Choose quick or fresh folder scanning.");
    out.folderScanMode = input.folderScanMode;
  }
  if (!settings && input.operation !== undefined) {
    if (!["full", "folder-sizes"].includes(input.operation))
      throw error("Choose a supported scan operation.");
    out.operation = input.operation;
  }
  if (input.developmentRoots !== undefined) {
    try {
      out.developmentRoots = normalizeRoots(input.developmentRoots);
    } catch (e) {
      throw error(e.message);
    }
  }
  const ranges = {
    minimumBytes: [1, 1024 ** 4],
    largeFileBytes: [1, 1024 ** 5],
    staleDays: [1, 36500],
    duplicateMinBytes: [1, 1024 ** 4],
    hashBudgetBytes: [1, 1024 ** 4],
    maxFiles: [1, 1000000],
    folderMinBytes: [0, 1024 ** 5],
    opportunityAgeDays: [0, 36500],
    opportunityMinBytes: [0, 1024 ** 5],
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
  for (const key of ["duplicates", "skipCloud"])
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

export async function createApp({
  dataDir = path.join(appRoot, ".reclaim"),
  dev = false,
  revealFolder = openFolder,
  routineProbe = probeNpmGuides,
  // Trusted embedding/test dependency only; HTTP bodies cannot replace cleanup.
  cleanupFactory = createCleanup,
} = {}) {
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
    settings: { ...defaults, ...stored?.settings },
    scans: stored?.scans || [],
    reviews: Object.fromEntries(
      Object.entries(stored?.reviews || {}).map(([id, value]) => [
        id,
        normalizeReview(value),
      ]),
    ),
    cleanups: stored?.cleanups || [],
    routines: loadRoutinePresets(stored?.routines),
  };
  const token = randomBytes(32).toString("hex");
  const opportunityIndex = createOpportunityIndex({ dataDir });
  const measurementJobs = await createMeasurementJobs({ dataDir });
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
    return normalizeFolderReport(
      JSON.parse(await readFile(path.join(dataDir, id + ".json"), "utf8")),
    );
  };
  let mainCheckout = appRoot;
  try {
    mainCheckout = parseWorktrees(
      await git(appRoot, "worktree", "list", "--porcelain", "-z"),
    )[0].worktree;
  } catch {}
  let cleanupBusy = false,
    developmentTargets = new Map(),
    cleanupIdle = Promise.resolve(),
    resolveCleanupIdle = () => {},
    closed = false;
  const cleanup = cleanupFactory({
    protectedPaths: [appRoot, mainCheckout, dataDir],
    onRecord: async (record) => {
      if (record.status === "deleted" && record.scanId && record.findingId)
        state.reviews[record.scanId] = dispositionReview(
          normalizeReview(state.reviews[record.scanId]),
          [record.findingId],
          "resolve",
        );
      const index = state.cleanups.findIndex((r) => r.id === record.id);
      if (index >= 0) state.cleanups[index] = record;
      else state.cleanups.unshift(record);
      await save();
    },
  });
  const measurementBusy = () => Boolean(measurementJobs.getSnapshot().job);
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
    if (job || cleanupBusy || measurementBusy())
      throw error(
        "Wait for the active scan, measurement or cleanup to finish.",
        409,
      );
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
  const cleanupChanges = () =>
    state.cleanups.map((record) => ({
      path: record.path,
      changedAt: Date.parse(record.completedAt || record.startedAt),
    }));
  const registerInventory = async (inventory, roots) => {
    for (let start = 0; start < inventory.targets.length; start += 12)
      await Promise.all(
        inventory.targets.slice(start, start + 12).map(async (target) => {
          const blocked = cleanup.protectionReason(target.path);
          if (blocked) {
            target.cleanupSupported = false;
            target.blockedReason = blocked;
            target.reason += " " + blocked;
          }
          target.activity = await probeActivity(target);
          developmentTargets.set(target.id, {
            ...target,
            discoveryRoots: roots,
          });
        }),
      );
    return inventory;
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
  const server = http.createServer(async (req, res) => {
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
    const url = new URL(req.url, origin);
    const json = (data, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
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
            measurementJob: measurementJobs.getSnapshot().job,
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
        if (req.method === "GET" && url.pathname === "/api/development") {
          opportunityIndex.ensure(state.scans);
          const roots = state.settings.developmentRoots;
          const inventory = await discoverDevelopment(roots, state.settings);
          if (roots !== state.settings.developmentRoots)
            throw error("Development roots changed. Refresh projects.", 409);
          json(await registerInventory(inventory, roots));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/intelligence") {
          const measured = measurementJobs.getSnapshot();
          json({
            index: opportunityIndex.getSnapshot(),
            measurements: measured.measurements,
            measurementJob: measured.job,
            measurementError: measured.error,
            changes: cleanupChanges(),
          });
          return;
        }
        const match = url.pathname.match(
          /^\/api\/scans\/([a-f\d-]+)(?:\/(report\.(?:csv|json)))?$/,
        );
        if (req.method === "GET" && match) {
          const s = await loadScan(match[1]);
          if (match[2] === "report.csv") {
            if (s.folderSizing) {
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
                "\uFEFF" +
                  rows.map((r) => r.map(csvCell).join(",")).join("\r\n"),
              );
              return;
            }
            const review = normalizeReview(state.reviews[s.id]);
            const rows = [
              [
                "Title",
                "Category",
                "Path",
                "Estimated logical bytes",
                "Risk",
                "Reason",
                "Impact",
                "Suggested action",
                "Selected",
                "Ignored",
                "Disposition",
              ],
              ...s.findings.map((f) => [
                f.title,
                f.category,
                f.path,
                f.bytes,
                f.risk,
                f.reason,
                f.impact,
                f.action,
                review.selected.includes(f.id),
                review.ignored.includes(f.id),
                {
                  open: "Open",
                  review: "In review",
                  resolved: "Resolved",
                  dismissed: "Dismissed",
                }[reviewStatus(review, f.id)],
              ]),
            ];
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="reclaim-report.csv"',
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
              review: normalizeReview(state.reviews[s.id]),
              sizeBasis: "Logical bytes, not measured allocated disk savings",
            });
            return;
          }
          json({ ...s, findings: await enrichFindings(s.findings) });
          return;
        }
        if (req.method !== "POST") throw error("Endpoint not found.", 404);
        if (req.headers["x-reclaim-token"] !== token)
          throw error("Session token missing. Reload the app.", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw error("Expected JSON.");
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 128000) throw error("Request too large.", 413);
        }
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
        if (
          url.pathname === "/api/development" ||
          url.pathname === "/api/development/quick"
        ) {
          opportunityIndex.ensure(state.scans);
          if (!discoveryOperations.includes(body.operation || "all"))
            throw error("Choose a supported discovery operation.");
          let roots;
          try {
            roots =
              body.root === undefined
                ? state.settings.developmentRoots
                : normalizeRoots([body.root]);
          } catch (e) {
            throw error(e.message);
          }
          if (url.pathname.endsWith("/quick")) {
            const records = { ...opportunityIndex.getSnapshot().records };
            if (!Object.keys(records).length) {
              const cached = await Promise.all(
                state.scans.map(async (scan) => {
                  try {
                    return await loadReportIndex(scan, {
                      dataDir,
                      cacheOnly: true,
                    });
                  } catch {
                    return null;
                  }
                }),
              );
              for (const cache of cached)
                for (const [id, record] of Object.entries(cache?.records || {}))
                  if (
                    !records[id] ||
                    Date.parse(record.recordedAt) >
                      Date.parse(records[id].recordedAt)
                  )
                    records[id] = record;
            }
            const targets = [];
            for (const record of Object.values(records)) {
              if (
                Date.parse(record.recordedAt || "") <=
                latestChange(record.path, cleanupChanges())
              )
                continue;
              if (!roots.some((root) => within(record.path, root))) continue;
              if (
                state.settings.exclusions.some((e) =>
                  path.isAbsolute(e)
                    ? within(record.path, path.resolve(e))
                    : record.path
                        .split(path.sep)
                        .some((part) => part.toLowerCase() === e.toLowerCase()),
                )
              )
                continue;
              if (
                state.settings.skipCloud &&
                record.path
                  .split(path.sep)
                  .some((part) => /^OneDrive/i.test(part))
              )
                continue;
              try {
                const target = await describeDiscoveryTarget(record.path);
                if (
                  target &&
                  (!body.operation ||
                    body.operation === "all" ||
                    target.category === body.operation)
                )
                  targets.push({ ...target, recorded: record });
              } catch {}
            }
            json(
              await registerInventory(
                {
                  source: "saved",
                  operation: body.operation || "all",
                  roots,
                  targets,
                  projects: [],
                  notices: [
                    "Quick look uses historical saved estimates, not a complete current directory discovery.",
                  ],
                  coverage: {
                    complete: false,
                    directoriesVisited: 0,
                    skippedSubtrees: 0,
                    directoryLimit: 100000,
                  },
                },
                roots,
              ),
            );
            return;
          }
          const inventory = await discoverDevelopment(roots, {
            ...state.settings,
            operation: body.operation || "all",
          });
          json(await registerInventory(inventory, roots));
          return;
        }
        if (url.pathname === "/api/intelligence/start") {
          opportunityIndex.ensure(state.scans);
          json({ ok: true });
          return;
        }
        if (url.pathname === "/api/measurements/cancel") {
          measurementJobs.cancel();
          json({ ok: true });
          return;
        }
        if (url.pathname === "/api/measurements/start") {
          if (job || cleanupBusy)
            throw error(
              "Finish the active scan or cleanup before measuring candidates.",
              409,
            );
          if (
            !Array.isArray(body.targetIds) ||
            !body.targetIds.length ||
            body.targetIds.length > 20 ||
            body.targetIds.some(
              (id) => typeof id !== "string" || !developmentTargets.has(id),
            )
          )
            throw error("Choose one to twenty known development folders.");
          const targets = body.targetIds.map((id) =>
            developmentTargets.get(id),
          );
          json(measurementJobs.start(targets), 202);
          return;
        }
        if (url.pathname === "/api/scans") {
          if (job || cleanupBusy || measurementBusy())
            throw error("A scan or cleanup is already running.", 409);
          const options = { ...state.settings, ...validate(body) };
          let info;
          try {
            info = await lstat(options.root);
          } catch {
            throw error("Folder not found or inaccessible.");
          }
          if (!info.isDirectory() || info.isSymbolicLink())
            throw error("Choose a regular folder.");
          // Filesystem validation yields; another request may have started a scan meanwhile.
          if (job || cleanupBusy || measurementBusy())
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
          if (
            body.developmentRoots !== undefined ||
            body.exclusions !== undefined ||
            body.skipCloud !== undefined
          )
            developmentTargets.clear();
          await save();
          json(state.settings);
          return;
        }
        if (
          url.pathname === "/api/cleanup/prepare" ||
          url.pathname === "/api/cleanup/execute"
        ) {
          if (job || cleanupBusy || measurementBusy())
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
            let target,
              kind = "generated",
              context = {};
            if (typeof body.targetId === "string") {
              const known = developmentTargets.get(body.targetId);
              if (
                !known ||
                !(known.discoveryRoots || state.settings.developmentRoots).some(
                  (root) => {
                    const relative = path.relative(root, known.path);
                    return (
                      relative === "" ||
                      (!relative.startsWith("..") && !path.isAbsolute(relative))
                    );
                  },
                )
              )
                throw error("Refresh Development and choose a known target.");
              target = known.path;
              kind = known.kind;
            } else if (
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
            } else if (
              typeof body.scanId === "string" &&
              typeof body.findingId === "string"
            ) {
              const scan = await loadScan(body.scanId),
                finding = scan.findings.find((f) => f.id === body.findingId);
              if (
                !finding ||
                !["builds", "dependencies"].includes(finding.category)
              )
                throw error("Choose a generated-folder finding.");
              target = finding.path;
              context = { scanId: scan.id, findingId: finding.id };
            } else
              throw error(
                "Choose a known development target or saved finding.",
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
          if (job || cleanupBusy || measurementBusy())
            throw error(
              "Finish active scans and cleanup before closing Reclaim.",
              409,
            );
          json({ ok: true });
          void closeApp();
          return;
        }
        if (url.pathname === "/api/review") {
          const s = await loadScan(body.scanId);
          const ids = new Set(s.findings.map((f) => f.id));
          const reviewInput = {
            selected: body.selected,
            ignored: body.ignored,
            resolved:
              body.resolved === undefined
                ? normalizeReview(state.reviews[s.id]).resolved
                : body.resolved,
          };
          for (const key of ["selected", "ignored", "resolved"])
            if (
              !Array.isArray(reviewInput[key]) ||
              reviewInput[key].length > s.findings.length ||
              reviewInput[key].some((id) => !ids.has(id))
            )
              throw error("Invalid review selection.");
          const claimed = new Set();
          for (const key of ["selected", "ignored", "resolved"])
            for (const id of new Set(reviewInput[key])) {
              if (claimed.has(id))
                throw error("A finding can have only one disposition.");
              claimed.add(id);
            }
          state.reviews[s.id] = normalizeReview(reviewInput);
          await save();
          json({ ok: true });
          return;
        }
        if (url.pathname === "/api/reveal") {
          const s = await loadScan(body.scanId);
          const known = new Set([
            s.root,
            ...s.findings.map((f) => f.path),
            ...s.files.map((f) => f.path),
            ...s.directories.map((f) => f.path),
          ]);
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
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end();
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
    } catch (e) {
      json({ error: e.message }, e.status || 500);
    }
  });
  async function closeApp() {
    if (closed) return;
    closed = true;
    job?.controller.abort();
    try {
      await job?.promise;
      await measurementJobs.close();
      await opportunityIndex.close();
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
