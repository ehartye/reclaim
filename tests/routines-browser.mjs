import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";

const temp = await mkdtemp(path.join(tmpdir(), "reclaim-routines-ui-"));
const root = path.join(temp, "project"),
  dist = path.join(root, "dist"),
  exact = path.join(root, "out"),
  cache = path.join(root, "cache", "_cacache"),
  unknownCache = path.join(root, "cache", "_npx"),
  missingCache = path.join(root, "cache", "unavailable"),
  dataDir = path.join(temp, "data");
for (const p of [root, dist, exact, cache, unknownCache, dataDir])
  await mkdir(p, { recursive: true });
await writeFile(
  path.join(root, "package.json"),
  JSON.stringify({ scripts: { build: "fixture-only" } }),
);
await writeFile(path.join(dist, "bundle"), "fixture");
await writeFile(path.join(exact, "bundle"), "equal");
await writeFile(path.join(cache, "entry"), "keep");
const scanId = "11111111-1111-4111-8111-111111111111",
  completedAt = new Date().toISOString();
const report = {
  id: scanId,
  root,
  name: "project",
  operation: "folder-sizes",
  status: "completed",
  startedAt: completedAt,
  completedAt,
  durationMs: 1,
  totalBytes: 1800000000,
  opportunityBytes: 0,
  fileCount: 3,
  directoryCount: 4,
  files: [],
  findings: [],
  duplicateGroups: [],
  skipped: [],
  errors: [],
  notices: [],
  options: { exclusions: [], skipCloud: true },
  directories: [
    { path: root, bytes: 1800000000, fileCount: 3, complete: true },
    { path: dist, bytes: 600000001, fileCount: 1, complete: true },
    { path: exact, bytes: 500000000, fileCount: 1, complete: true },
    {
      path: cache,
      bytes: 700000000,
      fileCount: 1,
      complete: false,
      estimated: true,
      measuredAt: "2026-01-01T00:00:00Z",
    },
  ],
  folderSizing: {
    minimumBytes: 500000000,
    basis: "logical-file-entries",
    scopeComplete: true,
    matchingCount: 3,
    accountingVersion: 2,
    estimated: true,
  },
};
await writeFile(path.join(dataDir, scanId + ".json"), JSON.stringify(report));
await writeFile(
  path.join(dataDir, "state.json"),
  JSON.stringify({
    settings: { developmentRoots: [root], exclusions: [], skipCloud: true },
    scans: [
      {
        ...report,
        files: undefined,
        findings: undefined,
        directories: undefined,
        findingCount: 0,
      },
    ],
    reviews: {},
    cleanups: [],
    routines: {
      schemaVersion: 1,
      presets: {
        "generated-output": {
          routineId: "generated-output",
          policyVersion: 1,
          minimumBytes: -123,
          minimumAgeDays: null,
          roots: [root],
        },
      },
    },
  }),
);
const app = await createApp({
  dataDir,
  routineProbe: async () => ({
    scopes: [cache, unknownCache, missingCache].map((scope) => ({
      routineId: "npm-cache",
      path: scope,
    })),
    notices: ["Fixture observation; no tool commands ran."],
  }),
  revealFolder: async () => {
    throw new Error("Do not open desktop folders in tests");
  },
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage();
const errors = [],
  requests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.url().includes("/api/") && r.method() === "POST")
    requests.push({ route: new URL(r.url()).pathname, body: r.postDataJSON() });
});
await page.route("https://**", (route) => route.abort());
await page.clock.install({ time: new Date() });
// Only fixture-backed routines may reach the server. In particular a newly
// added global routine must never silently inspect the developer's caches.
const unintercepted = [];
let fixtureRun = null,
  fixtureCatalog = null,
  failCatalog = false;
await page.route("**/api/routines", async (route) => {
  if (failCatalog) {
    await route.fulfill({
      status: 503,
      json: { error: "Fixture catalog unavailable" },
    });
  } else if (fixtureCatalog) {
    await route.fulfill({ json: fixtureCatalog });
  } else await route.continue();
});

const row = (id) => page.locator(`[data-routine-row='${id}']`);
const choice = (id) => page.locator(`[data-routine-id='${id}']`);
async function openRoutine(id) {
  if ((await choice(id).getAttribute("aria-expanded")) !== "true")
    await choice(id).click();
}
async function openSettings() {
  if ((await page.locator("#routine-settings").getAttribute("open")) === null)
    await page.locator("#routine-settings > summary").click();
}
async function openEvidence() {
  if ((await page.locator("#routine-evidence").getAttribute("open")) === null)
    await page.locator("#routine-evidence > summary").click();
}

async function verifyDecisionWorkspace() {
  const catalog = await (
    await page.request.get(
      `http://127.0.0.1:${app.server.address().port}/api/routines`,
    )
  ).json();
  fixtureCatalog = structuredClone(catalog);
  fixtureCatalog.invalidPresets = {};
  const commandScope = path.join(root, "qualified-cache");
  const guide = (qualified) => ({
    title: qualified
      ? "Fixture qualified maintenance"
      : "Fixture documentation only",
    mode: qualified ? "guided" : "review-only",
    qualified,
    steps: [
      "Close the owning tool and review the exact cache scope.",
      "Choose whether to follow the owner procedure.",
    ],
    notices: ["Fixture guide notice retained in full."],
    // An unqualified response carrying commands must still never expose them.
    commands: [
      {
        label: "Verify fixture cache",
        command: "npm cache verify --cache fixture-only",
        scope: commandScope,
        mutates: true,
        effects: "Validates cache entries and changes stored cache data.",
        optional: true,
      },
    ],
    evidence: ["https://docs.npmjs.com/cli/v11/commands/npm-cache"],
  });
  const candidate = (id, bytes, extra = {}) => ({
    id: `decision-${id}`,
    path: path.join(root, `decision-${id}`),
    label: "Fixture folder",
    mode: "review-only",
    cleanupSupported: false,
    reason: "Review only. This folder has no established cleanup procedure.",
    logicalBytes: bytes,
    estimated: false,
    complete: true,
    recordedAt: completedAt,
    ...extra,
  });
  let held = null,
    failIndividual = false;
  fixtureRun = async (route, body) => {
    if (held && body.routineId === "generated-output") await held.promise;
    if (
      body.routineId === "nvidia-shaders" ||
      (failIndividual && body.routineId === "generated-output")
    )
      return route.fulfill({
        status: 409,
        json: {
          error: "Fixture decision check failed; retry when the tool is idle.",
        },
      });
    const candidates =
      body.routineId === "generated-output"
        ? [
            candidate("eligible", 600000001, {
              mode: "in-app",
              cleanupSupported: true,
              reason: "Generated output can be rebuilt.",
              restore: "Run the project build.",
            }),
            candidate("blocked", null, {
              mode: "in-app",
              cleanupSupported: true,
              blockedReason:
                "Preserve this folder: its credentials and local configuration have no verified restoration source.",
            }),
          ]
        : body.routineId === "unreal-zen"
          ? [
              candidate("zen", 109000000000, {
                estimated: true,
                complete: false,
                blockedReason:
                  "Referenced cooked output may still be required. No safe cleanup is established for this store.",
              }),
            ]
          : body.routineId === "unreal-ddc"
            ? [
                candidate("ddc", 2000000000, {
                  estimated: true,
                  complete: false,
                }),
                candidate("unknown-ddc", null),
              ]
            : body.routineId === "npm-cache"
              ? [
                  candidate("guided", 700000000, {
                    mode: "guided",
                    guide: guide(true),
                  }),
                ]
              : body.routineId === "pip-cache"
                ? [
                    candidate("unqualified", null, {
                      mode: "guided",
                      guide: guide(false),
                    }),
                  ]
                : body.routineId === "windows-temporary"
                  ? []
                  : [candidate(body.routineId, null)];
    const partial = ["unreal-ddc", "unreal-zen"].includes(body.routineId);
    return route.fulfill({
      json: {
        id: `decision-run-${body.routineId}`,
        routineId: body.routineId,
        policyVersion: 1,
        parameters: { routineId: body.routineId, ...body.parameters },
        ...(body.scanId ? { scanId: body.scanId } : {}),
        checkedAt: await page.evaluate(() => new Date().toISOString()),
        candidates,
        coverage: {
          complete: !partial,
          candidateCount: candidates.length + (partial ? 1 : 0),
          checkedDirectories: candidates.length,
          errors: partial
            ? [
                {
                  path: path.join(root, "unavailable-evidence"),
                  reason: "Fixture coverage evidence unavailable.",
                },
              ]
            : [],
        },
        notices: [
          "Fixture complete server notice retained in supporting evidence.",
        ],
      },
    });
  };
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.locator(".routine-comparison-row")).toHaveCount(14);
  await expect(page.locator(".routine-detail")).toHaveCount(0);
  expect(await page.getByRole("columnheader").allTextContents()).toEqual([
    "Routine",
    "Recorded size",
    "What you can do",
    "Risk",
  ]);
  for (const definition of catalog.definitions) {
    await expect(
      row(definition.id).locator(".routine-explanation"),
    ).not.toBeEmpty();
    await expect(row(definition.id).locator(".routine-risk")).not.toBeEmpty();
    await expect(
      row(definition.id).getByRole("button", {
        name: "Check routine",
        exact: true,
      }),
    ).toBeVisible();
    await expect(row(definition.id)).toContainText("Size unknown");
  }
  await page.evaluate(() => scrollTo(0, 0));
  const visibleRows = await page
    .locator(".routine-comparison-row")
    .evaluateAll(
      (rows) =>
        rows.filter(
          (row) =>
            row.getBoundingClientRect().top >= 0 &&
            row.getBoundingClientRect().bottom <= innerHeight,
        ).length,
    );
  expect(visibleRows).toBeGreaterThanOrEqual(6);
  expect(
    await page
      .locator(
        ".routine-choice, .routine-explanation, .routine-risk, .routine-potential",
      )
      .evaluateAll((elements) =>
        elements.every(
          (element) => parseFloat(getComputedStyle(element).fontSize) >= 14,
        ),
      ),
  ).toBe(true);
  const audit = async () => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  };
  const summaryInViewport = async () => {
    const bounds = await page.locator(".routine-decision").boundingBox();
    const navBottom = await page.locator(".sidebar").evaluate((element) =>
      getComputedStyle(element).position === "sticky"
        ? element.getBoundingClientRect().bottom
        : 0,
    );
    const heading = await page.locator(".routine-detail > h2").boundingBox();
    expect(heading.y).toBeGreaterThanOrEqual(navBottom);
    expect(bounds.y).toBeGreaterThanOrEqual(navBottom);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      page.viewportSize().height,
    );
    await expect(page.locator(".routine-decision button")).toBeInViewport();
  };
  await audit();
  await page.screenshot({
    path: "review/routines-decision-collapsed-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await audit();
  await page.screenshot({
    path: "review/routines-decision-collapsed-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  const batchStart = requests.length;
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect(page.locator(".routine-batch-progress")).toContainText(
    "Routine checks settled",
  );
  expect(
    requests
      .slice(batchStart)
      .every((request) => request.route === "/api/routines/run"),
  ).toBe(true);
  await expect(row("unreal-zen")).toContainText("≈ 109 GB recorded");
  await expect(row("unreal-ddc")).toContainText("1 unknown size");
  await expect(
    row("nvidia-shaders").getByRole("button", {
      name: "Try again",
      exact: true,
    }),
  ).toBeVisible();
  await expect(row("nvidia-shaders")).toContainText(
    "Fixture decision check failed",
  );
  await expect(row("windows-temporary")).toContainText(
    "No matches under saved filters",
  );
  const browseStart = requests.length;
  await choice("generated-output").focus();
  await page.keyboard.press("Enter");
  await summaryInViewport();
  await expect(
    page.locator(".routine-disclosures > details[open]"),
  ).toHaveCount(0);
  await expect(page.locator(".routine-folders-heading")).toContainText(
    "1 eligible for review · 1 review only",
  );
  await expect(
    page
      .locator(".routine-candidate")
      .filter({ hasText: "credentials and local configuration" }),
  ).toContainText("Review only");
  await expect(
    page
      .locator(".routine-candidate")
      .filter({ hasText: "credentials and local configuration" })
      .getByRole("button", { name: "Review cleanup", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review cleanup", exact: true }),
  ).toHaveCount(1);
  await audit();
  await page.screenshot({
    path: "review/routines-decision-actionable-desktop.png",
  });
  await row("generated-output")
    .getByRole("button", { name: "Review folders", exact: true })
    .click();
  await expect(page.locator("#routine-folders")).toBeInViewport();
  expect(requests.length).toBe(browseStart);
  // Exact provenance, all diagnostics and the catalog boundary remain reachable.
  await openEvidence();
  await expect(page.locator("#routine-evidence")).toContainText(
    "600,000,001 exact recorded bytes",
  );
  await expect(page.locator("#routine-evidence")).toContainText(completedAt);
  await expect(page.locator("#routine-evidence")).toContainText(
    catalog.definitions.find((item) => item.id === "generated-output").boundary,
  );
  await expect(page.locator("#routine-evidence")).toContainText(
    "Fixture complete server notice",
  );
  await expect(page.locator("#routine-evidence")).toContainText(
    "1 unknown size",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await choice("generated-output").click();
  await choice("generated-output").click();
  await summaryInViewport();
  await audit();
  await page.screenshot({
    path: "review/routines-decision-actionable-mobile.png",
  });
  for (const viewport of [
    { width: 1440, height: 1050 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openRoutine("unreal-zen");
    if (viewport.width === 390) {
      await choice("unreal-zen").click();
      await choice("unreal-zen").click();
    }
    await summaryInViewport();
    await expect(page.locator(".routine-detail")).toContainText(
      "Referenced cooked output may still be required",
    );
    await expect(page.locator(".routine-detail")).toContainText("Review only");
    await expect(
      page
        .locator(".routine-detail")
        .getByRole("button", { name: "Review cleanup", exact: true }),
    ).toHaveCount(0);
    await audit();
    await page.screenshot({
      path: `review/routines-decision-zen-${viewport.width === 390 ? "mobile" : "desktop"}.png`,
    });
  }
  // The fixed navigation also applies between the narrow-card and phone
  // breakpoints; selection must stay unobscured throughout that range.
  await page.setViewportSize({ width: 600, height: 844 });
  await choice("unreal-zen").click();
  await choice("unreal-zen").click();
  await summaryInViewport();
  await audit();
  await page.setViewportSize({ width: 390, height: 844 });
  await openEvidence();
  await expect(page.locator("#routine-evidence")).toContainText(
    "Fixture coverage evidence unavailable",
  );
  await expect(page.locator("#routine-evidence")).toContainText(
    "109,000,000,000 exact recorded bytes",
  );
  // Double every computed text size to model browser text enlargement, including
  // pixel-sized interface text. Preserve the original inline styles for cleanup.
  await page.evaluate(() => {
    const entries = [
      ...document.querySelectorAll(
        ".routines-workspace, .routines-workspace *",
      ),
    ].map((element) => ({
      element,
      size: getComputedStyle(element).fontSize,
      old: element.getAttribute("style"),
    }));
    for (const { element, size, old } of entries) {
      element.dataset.testOriginalStyle = old ?? "";
      element.style.fontSize = `${parseFloat(size) * 2}px`;
    }
  });
  await audit();
  await page.evaluate(() =>
    document
      .querySelectorAll("[data-test-original-style]")
      .forEach((element) => {
        const old = element.dataset.testOriginalStyle;
        if (old) element.setAttribute("style", old);
        else element.removeAttribute("style");
        delete element.dataset.testOriginalStyle;
      }),
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await row("npm-cache")
    .getByRole("button", { name: "View guidance", exact: true })
    .click();
  await expect(page.locator("#routine-guidance")).toHaveAttribute("open", "");
  await expect(page.locator(".routine-command")).toContainText(
    "Changes cache data",
  );
  await expect(page.locator(".routine-command")).toContainText(
    "Validates cache entries and changes stored cache data.",
  );
  await expect(page.locator(".routine-command")).toContainText(commandScope);
  await expect(page.locator(".routine-command")).toContainText("Optional");
  await expect(
    page.getByRole("button", { name: "Copy command", exact: true }),
  ).toHaveCount(1);
  await row("pip-cache")
    .getByRole("button", { name: "Read guidance", exact: true })
    .click();
  await expect(page.locator("#routine-guidance")).toContainText(
    "Documentation only",
  );
  await expect(
    page.getByRole("button", { name: "Copy command", exact: true }),
  ).toHaveCount(0);
  await row("windows-temporary")
    .getByRole("button", { name: "Review filters", exact: true })
    .click();
  await expect(page.locator("#routine-settings")).toHaveAttribute("open", "");
  expect(requests.length).toBe(browseStart);
  // A compact retry uses saved settings and never writes a preset.
  await row("nvidia-shaders")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(page.locator(".routine-detail .alert.error")).toContainText(
    "Fixture decision check failed",
  );
  expect(requests.at(-1).route).toBe("/api/routines/run");
  const { routineId, ...savedParameters } = catalog.presets["nvidia-shaders"];
  expect(requests.at(-1).body.parameters).toEqual(savedParameters);
  // Browse while an individual request is pending. A late failure belongs to
  // its original row and cannot overwrite the newly selected form or error.
  let release;
  held = {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
  };
  failIndividual = true;
  await openRoutine("generated-output");
  await openSettings();
  await page
    .getByRole("button", { name: "Run routine check", exact: true })
    .click();
  await expect(
    row("generated-output").getByRole("button", {
      name: "Review folders",
      exact: true,
    }),
  ).toBeVisible();
  await openRoutine("engine-imports");
  await openSettings();
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    String(catalog.presets["engine-imports"].minimumBytes / 1e6),
  );
  await expect(
    page.getByRole("button", { name: "Save preset", exact: true }),
  ).toBeDisabled();
  release();
  await expect(row("generated-output")).toContainText(
    "Fixture decision check failed",
  );
  await expect(page.locator(".routine-detail .alert.error")).toHaveCount(0);
  await expect(choice("engine-imports")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    String(catalog.presets["engine-imports"].minimumBytes / 1e6),
  );
  expect(
    requests
      .slice(batchStart)
      .every((request) => request.route === "/api/routines/run"),
  ).toBe(true);
  fixtureRun = null;
  fixtureCatalog = null;
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
}
await page.route("**/api/routines/run", async (route) => {
  const body = route.request().postDataJSON();
  if (fixtureRun) return fixtureRun(route, body);
  if (!["generated-output", "npm-cache"].includes(body.routineId)) {
    unintercepted.push(body.routineId);
    await route.abort();
  } else await route.continue();
});

async function verifyBatchWorkspace() {
  const catalog = await (
    await page.request.get(
      `http://127.0.0.1:${app.server.address().port}/api/routines`,
    )
  ).json();
  fixtureCatalog = structuredClone(catalog);
  fixtureCatalog.invalidPresets["pip-cache"] = {
    parameters: { minimumBytes: -1 },
    error: "Fixture saved size needs correction",
  };
  const runAll = page.getByRole("button", { name: "Run all", exact: true });
  const check = page.getByRole("button", {
    name: "Run routine check",
    exact: true,
  });
  const prepare = page.getByRole("button", {
    name: "Review cleanup",
    exact: true,
  });
  const status = page.locator(".routine-batch-progress");
  const deferred = () => {
    let resolve;
    const promise = new Promise((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };
  let ids = [],
    held = deferred(),
    heldId = "npm-cache",
    realGenerated = true;
  const known = (id, bytes, extra = {}) => ({
    id: `fixture-${id}`,
    path: path.join(root, `scope-${id}`),
    mode: "review-only",
    cleanupSupported: false,
    reason: "Disposable browser response fixture",
    logicalBytes: bytes,
    estimated: false,
    complete: true,
    recordedAt: completedAt,
    ...extra,
  });
  const respond = async (route, body) => {
    ids.push(body.routineId);
    if (body.routineId === heldId) await held.promise;
    if (realGenerated && body.routineId === "generated-output") {
      const response = await route.fetch();
      return route.fulfill({ response });
    }
    if (body.routineId === "nvidia-shaders")
      return route.fulfill({
        status: 409,
        json: { error: "Fixture service busy" },
      });
    const checkedAt = await page.evaluate(() => new Date().toISOString());
    const candidates =
      body.routineId === "unreal-ddc"
        ? [
            known("ddc", 2000000000, { estimated: true, complete: false }),
            known("unknown", null),
          ]
        : body.routineId === "engine-imports"
          ? [
              known("imports", 800000000, {
                mode: "in-app",
                cleanupSupported: true,
              }),
            ]
          : body.routineId === "generated-output"
            ? [
                known("generated", 600000001, {
                  mode: "in-app",
                  cleanupSupported: true,
                }),
              ]
            : [];
    await route.fulfill({
      json: {
        id: `fixture-run-${body.routineId}-${ids.length}`,
        routineId: body.routineId,
        policyVersion: 1,
        parameters: { routineId: body.routineId, ...body.parameters },
        ...(body.scanId ? { scanId: body.scanId } : {}),
        checkedAt,
        candidates,
        coverage: {
          complete: body.routineId !== "unreal-ddc",
          candidateCount: candidates.length,
          checkedDirectories: candidates.length,
          errors: [],
        },
        notices: [],
      },
    });
  };
  fixtureRun = respond;
  await openRoutine("generated-output");
  await openSettings();
  await page.getByLabel("Routine minimum size in MB").fill("501");
  await expect(runAll).toBeDisabled();
  const beforeRevert = requests.length;
  await choice("npm-cache").click();
  await expect(choice("generated-output")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(choice("npm-cache")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    "501",
  );
  await expect(
    row("npm-cache").getByRole("button", {
      name: "Check routine",
      exact: true,
    }),
  ).toBeDisabled();
  await page.locator("#routine-settings > summary").click();
  await expect(page.locator(".routine-dirty")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save preset", exact: true }),
  ).toBeVisible();
  expect(requests.length).toBe(beforeRevert);
  await page
    .getByRole("button", { name: "Use saved settings", exact: true })
    .click();
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    "500",
  );
  expect(requests.length).toBe(beforeRevert);
  await openSettings();
  const batchStart = requests.length;
  await runAll.click();
  await expect.poll(() => ids.includes("npm-cache")).toBe(true);
  await expect(page.locator(".routine-choice")).toHaveCount(
    catalog.definitions.length,
  );
  await expect(status).toContainText("Checking npm content-cache maintenance");
  await expect(row("pip-cache")).toContainText("Needs settings");
  await expect(row("nvidia-shaders")).toContainText("Fixture service busy");
  await expect(row("unreal-ddc")).toContainText("≈ 2 GB recorded");
  await expect(row("unreal-ddc")).toContainText("1 unknown size");
  await expect(row("unreal-ddc")).toContainText("Incomplete sizes");
  await expect(page.locator(".routine-choice").first()).toHaveAttribute(
    "data-routine-id",
    "unreal-ddc",
  );
  const beforeBrowse = requests.length;
  await openRoutine("unreal-ddc");
  await openRoutine("generated-output");
  await openSettings();
  await expect(page.locator(".routine-candidate")).toHaveCount(1);
  await expect(prepare).toBeDisabled();
  await expect(check).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save preset", exact: true }),
  ).toBeDisabled();
  await expect(runAll).toBeDisabled();
  expect(requests.length).toBe(beforeBrowse);
  await choice("generated-output").focus();
  held.resolve();
  await expect(status).toContainText("Routine checks settled");
  await expect(choice("generated-output")).toBeFocused();
  await expect(choice("generated-output")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(prepare).toBeEnabled();
  expect(ids).toEqual(
    catalog.definitions
      .filter((item) => item.id !== "pip-cache")
      .map((item) => item.id),
  );
  const batchRequests = requests.slice(batchStart);
  expect(
    batchRequests.every((request) => request.route === "/api/routines/run"),
  ).toBe(true);
  for (const request of batchRequests) {
    expect(request.body.scanId).toBe(scanId);
    const { routineId, ...parameters } =
      catalog.presets[request.body.routineId];
    expect(request.body.parameters).toEqual(parameters);
  }
  await expect(row("npm-cache")).toContainText(
    "No matches under saved filters",
  );
  const auditComparison = async () => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  };
  await auditComparison();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "review/routines-comparison-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await auditComparison();
  await choice("generated-output").click();
  await choice("generated-output").click();
  await expect(page.locator(".routine-decision")).toBeInViewport();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "review/routines-comparison-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await openSettings();
  // An unexpired retained batch result reaches only the existing server-ID route.
  await prepare.click();
  await expect(
    page.getByRole("dialog", { name: "Confirm permanent deletion" }),
  ).toContainText("npm run build");
  expect(requests.at(-1).route).toBe("/api/routines/candidates/prepare");
  expect(Object.keys(requests.at(-1).body).sort()).toEqual([
    "candidateId",
    "runId",
  ]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const preserved = await row("unreal-ddc").innerText();
  // An individual rerun replaces only its own row; a save clears only its row.
  await check.click();
  await expect(check).toBeEnabled();
  expect(await row("unreal-ddc").innerText()).toBe(preserved);
  await page.getByLabel("Routine minimum size in MB").fill("501");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(row("generated-output")).toContainText("Not run");
  expect(await row("unreal-ddc").innerText()).toBe(preserved);
  // Catalog failures do not masquerade as a successful new generation.
  failCatalog = true;
  const beforeFailure = ids.length;
  await runAll.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Catalog refresh failed" }),
  ).toBeVisible();
  expect(ids.length).toBe(beforeFailure);
  expect(await row("unreal-ddc").innerText()).toBe(preserved);
  failCatalog = false;
  // Stop retains the current response and prevents all later requests.
  ids = [];
  held = deferred();
  heldId = "unreal-ddc";
  const stopStart = requests.length;
  await runAll.click();
  await expect.poll(() => ids.length).toBe(1);
  await page
    .getByRole("button", { name: "Stop after current routine", exact: true })
    .click();
  await expect(runAll).toBeDisabled();
  held.resolve();
  await expect(status).toContainText("Routine checks settled");
  expect(ids).toEqual(["unreal-ddc"]);
  await expect(row("unreal-ddc")).toContainText("Partial discovery");
  await expect(row("generated-output")).toContainText("Not run");
  await expect(status).toContainText("12 not run");
  expect(
    requests
      .slice(stopStart)
      .every((request) => request.route === "/api/routines/run"),
  ).toBe(true);
  // A seven-minute foreground batch cannot renew the early result's proof.
  ids = [];
  held = deferred();
  heldId = "gradle-cache";
  realGenerated = false;
  const expiryStart = requests.length;
  await runAll.click();
  await expect.poll(() => ids.includes("gradle-cache")).toBe(true);
  await page.clock.fastForward(7 * 60 * 1000);
  held.resolve();
  await expect(status).toContainText("Routine checks settled");
  await openRoutine("generated-output");
  await expect(prepare).toBeDisabled();
  await expect(page.locator(".routine-detail")).toContainText(
    "Run again to review cleanup",
  );
  await openRoutine("engine-imports");
  await expect(prepare).toBeEnabled();
  await openRoutine("generated-output");
  await expect(prepare).toBeDisabled();
  await expect(row("generated-output")).toContainText("Evidence expired");
  expect(
    requests
      .slice(expiryStart)
      .every((request) => request.route === "/api/routines/run"),
  ).toBe(true);
  // Navigation disposes the queue; an obsolete response cannot resume it.
  ids = [];
  held = deferred();
  heldId = "unreal-ddc";
  await runAll.click();
  await expect.poll(() => ids.length).toBe(1);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "Explore sample", exact: true })
    .click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(status).toContainText("Ready to check routines");
  held.resolve();
  await expect(row("unreal-ddc")).toContainText("Not run");
  expect(ids).toEqual(["unreal-ddc"]);
  await expect(page.getByText(/No real report selected/)).toBeVisible();
  ids = [];
  heldId = "";
  const sampleStart = requests.length;
  await runAll.click();
  await expect(status).toContainText("Routine checks settled");
  expect(
    requests
      .slice(sampleStart)
      .every(
        (request) =>
          request.route === "/api/routines/run" && !("scanId" in request.body),
      ),
  ).toBe(true);
  await expect(row("unreal-ddc")).toContainText("Size unknown");
  await expect(row("unreal-ddc")).not.toContainText("2 GB");
  await openRoutine("unreal-ddc");
  await expect(page.locator(".routine-candidate-size").first()).toContainText(
    "Size unknown",
  );
  await expect(page.locator(".routine-candidate-size").first()).toContainText(
    "No recorded size date",
  );
  // A report change during another pending sample check also suppresses callbacks.
  ids = [];
  held = deferred();
  heldId = "unreal-ddc";
  await runAll.click();
  await expect.poll(() => ids.length).toBe(1);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".history-row").first().click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(status).toContainText("Ready to check routines");
  held.resolve();
  await expect(row("unreal-ddc")).toContainText("Not run");
  expect(ids).toEqual(["unreal-ddc"]);
  await expect(page.getByText(/No real report selected/)).toHaveCount(0);
  await page.clock.setSystemTime(new Date());
  fixtureRun = null;
  fixtureCatalog = null;
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  // Restore the strict 500 MB fixture for the independent deletion regression.
  await openRoutine("generated-output");
  await openSettings();
  await page.getByLabel("Routine minimum size in MB").fill("500");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(
    page.getByText("Preset saved for the next run.", { exact: true }),
  ).toBeVisible();
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await expect(
    page.getByRole("button", { name: "Routines", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.locator(".routine-detail")).toHaveCount(0);
  await row("generated-output")
    .getByRole("button", { name: "Fix settings", exact: true })
    .click();
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    "500",
  );
  await expect(page.getByLabel("Routine age hint")).toHaveValue("off");
  await expect(
    page.getByLabel("Retained saved routine parameters"),
  ).toContainText('"minimumBytes": -123');
  await expect(
    page.getByRole("button", { name: "Run routine check", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(
    page.getByLabel("Retained saved routine parameters"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Run routine check", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Routine project roots").fill(root + "\n");
  await expect(page.getByLabel("Routine project roots")).toHaveValue(
    root + "\n",
  );
  await page
    .getByLabel("Routine project roots")
    .fill(root.replaceAll("\\", "/") + "/");
  await page
    .getByRole("button", { name: "Run routine check", exact: true })
    .click();
  await expect(page.locator(".routine-candidate")).toHaveCount(1);
  await expect(page.locator(".routine-candidate")).toContainText("600 MB");
  await expect(page.locator(".routine-candidate")).toContainText("Recorded");
  await expect(page.getByLabel("Routine project roots")).toHaveValue(root);
  await expect(page.getByText(/Parameters changed/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review cleanup", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Routine minimum size in MB").fill("600.000001");
  await expect(
    page.getByRole("button", { name: "Review cleanup", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Run routine check", exact: true })
    .click();
  await expect(page.locator(".routine-candidate")).toHaveCount(0);
  await page.getByLabel("Routine minimum size in MB").fill("500");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(
    page.getByText("Preset saved for the next run.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await openRoutine("generated-output");
  await openSettings();
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    "500",
  );
  await page
    .getByRole("button", { name: /npm content-cache maintenance/ })
    .click();
  await openSettings();
  await page
    .getByRole("button", { name: "Run routine check", exact: true })
    .click();
  await expect(page.locator(".routine-candidate")).toHaveCount(2);
  await expect(page.locator(".routine-candidate .routine-mode")).toHaveText([
    "Review only",
    "Review only",
  ]);
  const estimatedCandidate = page
    .locator(".routine-candidate")
    .filter({ hasText: "≈ 700 MB" });
  await expect(estimatedCandidate).toContainText("Incomplete");
  await expect(estimatedCandidate).toContainText("Recorded");
  const unknownCandidate = page
    .locator(".routine-candidate")
    .filter({ hasText: "Size unknown" });
  await expect(unknownCandidate).toContainText("No recorded size date");
  await expect(unknownCandidate).toContainText(
    "parent-container bytes are not substituted",
  );
  await expect(page.getByText(/Partial coverage ·/)).toBeVisible();
  await openEvidence();
  await expect(page.getByText(/Quick scan reused dated totals/)).toBeVisible();
  await expect(
    page.getByText(/Unknown-size leads have not met the threshold/),
  ).toBeVisible();
  await estimatedCandidate
    .getByRole("button", { name: "Read guidance", exact: true })
    .click();
  await expect(page.locator("#routine-guidance")).toContainText(
    "npm cache verify is mutating",
  );
  await expect(
    page
      .locator(".routine-guide")
      .getByRole("button", { name: /Copy command/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review cleanup", exact: true }),
  ).toHaveCount(0);
  expect(
    requests.filter(
      (r) => r.route.includes("prepare") || r.route.includes("execute"),
    ),
  ).toEqual([]);
  const audit = async () => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
  };
  await audit();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "review/routines-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await audit();
  await page.screenshot({ path: "review/routines-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await verifyDecisionWorkspace();
  await verifyBatchWorkspace();
  // The legacy caller still prepares through its original route.
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page
    .getByLabel("Folder category", { exact: true })
    .selectOption("builds");
  await page
    .getByRole("button", { name: "Review cleanup for dist", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Confirm permanent deletion" }),
  ).toContainText("npm run build");
  expect(requests.at(-1).route).toBe("/api/cleanup/prepare");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await openRoutine("generated-output");
  await openSettings();
  await page
    .getByRole("button", { name: "Run routine check", exact: true })
    .click();
  await expect(page.locator(".routine-candidate")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Review cleanup", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Confirm permanent deletion",
  });
  await expect(dialog).toContainText("npm run build");
  expect(requests.at(-1).route).toBe("/api/routines/candidates/prepare");
  expect(Object.keys(requests.at(-1).body).sort()).toEqual([
    "candidateId",
    "runId",
  ]);
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  const phrase = await dialog
    .locator("label[for='delete-phrase'] strong")
    .innerText();
  await page.locator("#delete-phrase").fill(phrase);
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(dialog).toContainText("Deleted permanently");
  expect(requests.at(-1).route).toBe("/api/cleanup/execute");
  await expect
    .poll(async () => {
      try {
        await stat(dist);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  expect((await stat(path.join(cache, "entry"))).isFile()).toBe(true);
  expect(errors).toEqual([]);
  expect(unintercepted).toEqual([]);
  console.log(
    "Routines Chromium passed: fourteen concise decisions, six-row desktop density, inline desktop/mobile summary, mixed restrictions, qualified/documentation-only guidance, retained provenance/disclosures, dirty navigation/compact-check guards, pending individual-check browsing, saved-preset sequential comparison, sorting/focus, failure/invalid/stop/refresh guards, seven-minute independent expiry, report/navigation disposal, unknown sample sizes, zero implicit writes/preparation/execution, legacy/ID-based confirmation and disposable deletion, 200% text, overflow and accessibility.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
