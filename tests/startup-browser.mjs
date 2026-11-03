import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { scan } from "../server/scanner.mjs";
const temp = await mkdtemp(path.join(tmpdir(), "reclaim-startup-"));
const root = path.join(temp, "Current folders");
await mkdir(root);
await writeFile(path.join(root, "current.txt"), "current");
const report = await scan({
  root,
  operation: "folder-sizes",
  folderMinBytes: 0,
});
const app = await createApp({ dataDir: path.join(temp, "state") });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const state = await fetch(base + "/api/state").then((r) => r.json());
const summary = { ...report, operation: "folder-sizes" };
const browser = await chromium.launch({ headless: true });
const failures = [];
await mkdir("review", { recursive: true });
try {
  for (const scenario of [
    "delayed-state",
    "delayed-report",
    "navigation-during-report",
    "empty",
    "failed-state",
    "failed-report",
    "missing-report",
    "unsupported-report",
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    const posts = [],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.addInitScript(() => {
      window.navigationSnapshots = [];
      const record = () => {
        const nav = document.querySelector("aside");
        if (nav) window.navigationSnapshots.push(nav.textContent);
      };
      new MutationObserver(record).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    let releaseState, releaseReport;
    const stateGate = new Promise((r) => (releaseState = r)),
      reportGate = new Promise((r) => (releaseReport = r));
    await page.route("**/api/state", async (route) => {
      if (scenario === "delayed-state") await stateGate;
      await route.fulfill({
        status: scenario === "failed-state" ? 503 : 200,
        json:
          scenario === "failed-state"
            ? { error: "Service unavailable" }
            : {
                ...state,
                scans: ["empty", "delayed-state"].includes(scenario)
                  ? []
                  : [summary],
              },
      });
    });
    await page.route("**/api/scans/*", async (route) => {
      if (["delayed-report", "navigation-during-report"].includes(scenario))
        await reportGate;
      const status =
        scenario === "missing-report"
          ? 404
          : scenario === "unsupported-report"
            ? 400
            : scenario === "failed-report"
              ? 503
              : 200;
      await route.fulfill({
        status,
        json:
          status === 200
            ? report
            : {
                error:
                  status === 404
                    ? "Report unavailable"
                    : status === 400
                      ? "Unsupported report format"
                      : "Report request failed",
              },
      });
    });
    try {
      await page.goto(base);
      await expect(
        page.getByRole("navigation", { name: "Main navigation" }),
      ).toBeVisible();
      const settings = page.getByRole("button", {
        name: "Folders",
        exact: true,
      });
      await settings.focus();
      if (scenario.startsWith("delayed")) {
        await expect(
          page.getByText(
            scenario === "delayed-state"
              ? "Loading workspace…"
              : "Loading folder report…",
            { exact: true },
          ),
        ).toBeVisible();
        await page.screenshot({
          path: `review/startup-${scenario}-desktop.png`,
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: `review/startup-${scenario}-mobile.png`,
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 1050 });
      }
      let focusTarget = settings;
      if (scenario === "navigation-during-report") {
        await expect(
          page.getByText("Loading folder report…", { exact: true }),
        ).toBeVisible();
        focusTarget = page.getByRole("button", {
          name: "Scan settings",
          exact: true,
        });
        await focusTarget.click();
      }
      releaseState();
      releaseReport();
      if (["empty", "delayed-state"].includes(scenario))
        await expect(
          page.getByRole("heading", {
            name: "No folder scans yet",
            exact: true,
          }),
        ).toBeVisible();
      else if (scenario === "delayed-report")
        await expect(page.locator(".folder-tree-row")).toHaveCount(1);
      else if (scenario === "navigation-during-report") {
        await expect(
          page.getByRole("button", { name: "Export report", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Settings", exact: true }),
        ).toBeVisible();
      } else await expect(page.getByRole("alert")).toBeVisible();
      await expect(focusTarget).toBeFocused();
      const snapshots = await page.evaluate(() => window.navigationSnapshots);
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.join("\n")).not.toMatch(
        /Overview|Opportunities|Review queue|Development|Space map|Duplicates|Sample/,
      );
      await expect(page.locator("body")).not.toContainText("Sample data");
      expect(posts).toEqual([]);
      expect(errors).toEqual([]);
      for (const size of [
        { width: 1440, height: 1050 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(
          violations.filter((v) => ["serious", "critical"].includes(v.impact)),
        ).toEqual([]);
        if (scenario === "empty")
          await page.screenshot({
            path: `review/startup-empty-${size.width}.png`,
            fullPage: true,
          });
      }
      await page
        .getByRole("button", { name: "Scan settings", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      if (scenario === "empty") {
        await page
          .getByRole("button", { name: "History", exact: true })
          .click();
        await expect(page.locator(".history-row")).toHaveCount(0);
        await page
          .getByRole("button", { name: "Routines", exact: true })
          .click();
        await expect(page.locator(".routine-comparison-row")).toHaveCount(14);
        expect(posts).toEqual([]);
      }
    } catch (e) {
      failures.push(`${scenario}: ${e.message}`);
    } finally {
      releaseState();
      releaseReport();
      await context.close();
    }
  }
  expect(failures).toEqual([]);
  console.log("Startup current-only cases passed.");
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
