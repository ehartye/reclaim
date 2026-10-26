import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createApp } from "../server/app.mjs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const temp = await mkdtemp(path.join(tmpdir(), "reclaim-browser-"));
const root = path.join(temp, "My workspace");
async function put(p, size, value, old = false) {
  const file = path.join(root, p);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, value));
  if (old) await utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
  return file;
}
const M = 1024 ** 2;
await put("atlas/package.json", 2, 1);
await put("atlas/node_modules/lib/data.bin", 4 * M, 2);
await put("atlas/dist/bundle.js", 2 * M, 3);
await put("tools/.cache/cache.bin", 3 * M, 4);
await put("Downloads/setup.exe", 2 * M, 5, true);
await put("Documents/backup.bin", 2 * M, 6);
await put("Downloads/backup-copy.bin", 2 * M, 6);
await mkdir("review", { recursive: true });
const app = await createApp({
  dataDir: path.join(temp, "state"),
  revealFolder: async () => {
    throw new Error("Browser tests must intercept folder-opening requests.");
  },
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
// Saved full reports remain readable; their old scanner is exercised through its API.
async function legacyScan(duplicates = false) {
  const state = await fetch(base + "/api/state").then((r) => r.json());
  const response = await fetch(base + "/api/scans", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": state.token,
    },
    body: JSON.stringify({ root, duplicates, operation: "full" }),
  });
  expect(response.ok).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Your space, explained.", exact: true }),
  ).toBeVisible({ timeout: 30000 });
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1020 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
const audits = [];
async function audit(label) {
  const result = await new AxeBuilder({ page }).analyze();
  audits.push({ label, violations: result.violations });
}
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "Folders", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await page.screenshot({ path: "review/desktop-sample.png", fullPage: true });
  await audit("desktop sample overview");
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Mobile horizontal overflow");
  await page.screenshot({ path: "review/mobile-sample.png", fullPage: true });
  await page
    .getByRole("button", { name: "Scan settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await audit("mobile settings");
  await page.setViewportSize({ width: 1440, height: 1020 });
  await page.getByRole("button", { name: "New scan", exact: true }).click();
  await page.getByLabel("Folder path").fill(root);
  await audit("scan dialog");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await legacyScan(true);
  await expect(page.getByText("Sample data", { exact: true })).toHaveCount(0, {
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: /^Opportunities/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Opportunities/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(5);
  await page.getByLabel("Search opportunities").fill("node_modules");
  await expect(page.locator(".finding-row")).toHaveCount(1);
  await page.locator(".row-title").click();
  await expect(
    page.getByRole("heading", { name: "Why it’s here" }),
  ).toBeVisible();
  await audit("finding drawer");
  let revealRequest;
  await page.route("**/api/reveal", async (route) => {
    revealRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.getByRole("button", { name: "Open folder", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Folder requested in your file manager" }),
  ).toBeVisible();
  expect(revealRequest.path).toBe(path.join(root, "atlas", "node_modules"));
  expect(revealRequest.scanId).toBe(app.state.scans[0].id);
  await page.unroute("**/api/reveal");
  await page.route("**/api/reveal", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Windows could not open this folder" }),
    }),
  );
  await page.getByRole("button", { name: "Open folder", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Windows could not open this folder" }),
  ).toBeVisible();
  await page.unroute("**/api/reveal");
  await page
    .getByRole("button", { name: "Add to review", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Opportunities/ }).click();
  await page.route("**/api/review", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  await page.locator(".finding-row input[type=checkbox]").nth(1).check();
  await page.locator(".finding-row input[type=checkbox]").nth(2).check();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".history-row").first().click();
  await page.getByRole("button", { name: /^Review queue/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Export report" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Full report (.json)" }).click();
  const download = await downloadPromise;
  const report = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(report.review.selected).toHaveLength(3);
  expect(report.scan.root).toBe(root);
  await page.unroute("**/api/review");
  await page.reload();
  await page.getByRole("button", { name: /^Review queue/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Mark selected resolved", exact: true })
    .click();
  await expect(page.locator(".finding-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "View resolved items", exact: true })
    .click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(2);
  await page.getByRole("button", { name: /^Resolved/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await expect(page.locator(".resolved-label")).toHaveCount(3);
  await audit("resolved opportunities desktop");
  await page.screenshot({
    path: "review/resolved-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Resolved mobile overflow");
  await audit("resolved opportunities mobile");
  await page.screenshot({ path: "review/resolved-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1020 });
  await page.reload();
  await page.getByRole("button", { name: /^Opportunities/ }).click();
  await page.getByRole("button", { name: /^Resolved/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await page.locator(".row-title").first().click();
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Mark resolved", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".finding-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Export report" }).click();
  const resolvedDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Full report (.json)" }).click();
  const resolvedDownload = await resolvedDownloadPromise;
  const resolvedReport = JSON.parse(
    await readFile(await resolvedDownload.path(), "utf8"),
  );
  expect(resolvedReport.review.resolved).toHaveLength(2);
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await page.locator(".resolve-btn").first().click();
  await expect(page.locator(".finding-row")).toHaveCount(2);
  await page.getByRole("button", { name: /^Resolved/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Reopen visible", exact: true })
    .click();
  await expect(page.locator(".finding-row")).toHaveCount(0);
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.locator(".finding-row")).toHaveCount(5);
  await page.getByRole("button", { name: "Duplicates", exact: true }).click();
  await expect(page.locator(".duplicate-card")).toHaveCount(1);
  await expect(
    page.getByText("Suggested keeper", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Space map", exact: true }).click();
  await page
    .locator(".folder-list button")
    .filter({ hasText: "atlas" })
    .click();
  await expect(page.locator(".map-panel h2")).toHaveText("atlas");
  await page.getByRole("button", { name: "Up one level" }).click();
  await expect(page.locator(".map-panel h2")).toHaveText("My workspace");
  await page
    .getByRole("button", { name: "Scan settings", exact: true })
    .click();
  await page.getByLabel("Exclusions", { exact: true }).fill("tools");
  await page.getByLabel("Exclusions", { exact: true }).press("End");
  await page.getByLabel("Exclusions", { exact: true }).press("Enter");
  await page
    .getByLabel("Exclusions", { exact: true })
    .pressSequentially("private");
  await expect(page.getByLabel("Exclusions", { exact: true })).toHaveValue(
    "tools\nprivate",
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Scan settings saved" }),
  ).toBeVisible();
  await legacyScan();
  await expect.poll(() => app.state.scans.length, { timeout: 30000 }).toBe(2);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(2);
  await expect(page.getByText("Coverage changed; no comparison")).toBeVisible();
  await put("Documents/new-file.bin", M, 8);
  await legacyScan();
  await expect.poll(() => app.state.scans.length, { timeout: 30000 }).toBe(3);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("+1 MB since previous")).toBeVisible();
  await page.locator(".history-row").first().click();
  await page.screenshot({ path: "review/desktop-real.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Real mobile horizontal overflow");
  await page.screenshot({ path: "review/mobile-real.png", fullPage: true });
  expect(errors).toEqual([]);
  await audit("mobile real overview");
  await writeFile("review/accessibility.json", JSON.stringify(audits, null, 2));
  const serious = audits.flatMap((a) =>
    a.violations
      .filter((v) => ["serious", "critical"].includes(v.impact))
      .map((v) => ({
        screen: a.label,
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          reason: n.failureSummary,
        })),
      })),
  );
  console.log("Accessibility findings:", JSON.stringify(serious, null, 2));
  expect(serious).toEqual([]);
  console.log(
    "Browser workflow passed: sample, real scan, duplicates, filtering, details, queue persistence, JSON export, map drilldown, exclusions, history comparison, desktop/mobile without overflow or browser errors.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
