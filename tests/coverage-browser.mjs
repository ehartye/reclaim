import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { sample } from "../src/sample.ts";
const temp = await mkdtemp(path.join(tmpdir(), "reclaim-coverage-ui-"));
const app = await createApp({ dataDir: temp });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const state = await (await fetch(origin + "/api/state")).json();
const fixture = {
  ...structuredClone(sample),
  id: "coverage-fixture",
  root: "C:\\",
  status: "partial",
  fileCount: 4508086,
  directoryCount: 851291,
  skipped: Array.from({ length: 1000 }, (_, i) => ({
    path: `C:\\fixture\\dependencies\\link-${i}`,
    reason: "Link, offline file or cloud placeholder",
  })),
  errors: [
    {
      path: "C:\\fixture\\Temp",
      reason: "Folder entries changed while counting; refresh this branch.",
    },
    { path: "C:\\fixture\\SystemData", reason: "Access is denied." },
    {
      path: "C:\\fixture\\CapabilityAccessManager",
      reason: "Access is denied.",
    },
  ],
  notices: ["Folder cache could not be saved: Invalid string length"],
  folderSizing: {
    minimumBytes: 500000000,
    basis: "logical-file-entries",
    scopeComplete: false,
    matchingCount: 0,
  },
  directories: [],
};
state.scans = [{ ...fixture, operation: "folder-sizes" }];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
const mutations = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (request.method() !== "GET") {
    mutations.push(pathname);
    return route.abort();
  }
  if (pathname === "/api/state") return route.fulfill({ json: state });
  if (pathname === "/api/scans/coverage-fixture")
    return route.fulfill({ json: fixture });
  return route.continue();
});
try {
  await page.goto(origin);
  await page
    .getByRole("button", { name: "View coverage", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Scan coverage" });
  await expect(
    dialog.getByRole("heading", { name: "Needs attention (3 recorded)" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("C:\\fixture\\Temp", { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".coverage-group[open]")).toHaveCount(0);
  await expect(
    dialog.getByText("C:\\fixture\\dependencies\\link-0", { exact: true }),
  ).not.toBeVisible();
  await expect(dialog).toContainText("Cache was not saved");
  await expect(dialog).toContainText(
    "recorded samples, not complete category totals",
  );
  await mkdir("review", { recursive: true });
  await page.screenshot({ path: "review/coverage-desktop.png" });
  for (const viewport of [
    { width: 1440, height: 1050 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
  }
  await page.screenshot({ path: "review/coverage-mobile.png" });
  const summary = dialog.locator("summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".coverage-group[open]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".coverage-group[open]")).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    "Coverage browser passed: 1000 collapsed samples, 3 visible issues, desktop/mobile, keyboard, axe and zero mutations.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
