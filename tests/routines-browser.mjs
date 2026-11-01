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
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await expect(
    page.getByRole("button", { name: "Routines", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
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
  await expect(page.getByLabel("Routine minimum size in MB")).toHaveValue(
    "500",
  );
  await page
    .getByRole("button", { name: /npm content-cache maintenance/ })
    .click();
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
  await expect(page.getByText(/Quick scan reused dated totals/)).toBeVisible();
  await expect(
    page.getByText(/Unknown-size leads have not met the threshold/),
  ).toBeVisible();
  await estimatedCandidate
    .getByText(/Maintenance guidance · documentation only/)
    .click();
  await expect(estimatedCandidate.locator(".routine-guide")).toContainText(
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
  console.log(
    "Routines Chromium passed: folder-only navigation, invalid preset correction, strict decimal thresholds, normalized roots, persisted presets, estimated/unknown/incomplete size disclosure, documentation-only caches, stale guards, legacy/injected preparation, fixture confirmation/deletion, mobile layout and accessibility.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
