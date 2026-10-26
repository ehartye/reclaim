import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
const temp = await mkdtemp(path.join(tmpdir(), "reclaim-cleanup-browser-")),
  root = path.join(temp, "projects"),
  project = path.join(root, "example"),
  target = path.join(project, "build");
await mkdir(target, { recursive: true });
await writeFile(
  path.join(project, "package.json"),
  JSON.stringify({ scripts: { build: "vite build" } }),
);
await writeFile(path.join(target, "bundle.js"), "generated data");
await mkdir("review", { recursive: true });
const app = await createApp({
  dataDir: path.join(temp, "data"),
  revealFolder: async () => {
    throw new Error("Browser tests must not open desktop folders.");
  },
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1020 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage(),
  errors = [],
  audits = [];
page.on("pageerror", (e) => errors.push(e.message));
const audit = async (label) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  audits.push({ label, violations });
  expect(
    violations.filter((v) => ["serious", "critical"].includes(v.impact)),
  ).toEqual([]);
};
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page
    .getByRole("button", { name: "Scan settings", exact: true })
    .click();
  await page.getByLabel("Development folders", { exact: true }).fill(root);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Scan settings saved" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.locator(".development-target")).toHaveCount(1);
  await expect(page.locator(".restore-note")).toContainText("npm run build");
  await audit("development desktop");
  await page.screenshot({
    path: "review/development-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Review deletion", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Confirm permanent deletion" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Type DELETE build to confirm").fill("DELETE wrong");
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  await audit("permanent deletion preview");
  await page.screenshot({
    path: "review/deletion-preview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readFile(path.join(target, "bundle.js"), "utf8")).toBe(
    "generated data",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Development mobile overflow");
  await audit("development mobile");
  await page.screenshot({
    path: "review/development-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Review deletion", exact: true })
    .click();
  await page.getByLabel("Type DELETE build to confirm").fill("DELETE build");
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeEnabled();
  await audit("deletion preview mobile");
  await page.screenshot({
    path: "review/deletion-preview-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    page.getByText("Deleted permanently", { exact: true }),
  ).toBeVisible();
  await expect(async () => {
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  }).toPass();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".cleanup-history")).toContainText("deleted");
  await page
    .getByRole("button", { name: "Refresh projects", exact: true })
    .click();
  await expect(page.locator(".development-target")).toHaveCount(0);
  // Existing development cleanup remains a compatibility path; caches stay manual review.
  const cache = path.join(project, ".cache");
  await mkdir(cache);
  await writeFile(path.join(cache, "cached.bin"), "cache");
  await page
    .getByLabel("Discovery operation", { exact: true })
    .selectOption("caches");
  await expect(page.locator(".development-target")).toHaveCount(1);
  await expect(page.locator(".development-target")).toContainText(cache);
  await expect(
    page.getByRole("button", { name: "Manual review required", exact: true }),
  ).toBeDisabled();
  expect(app.state.scans).toHaveLength(0);
  await audit("compatibility cache review mobile");
  await page.reload();
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.locator(".cleanup-history")).toContainText("deleted");
  expect(errors).toEqual([]);
  await writeFile(
    "review/cleanup-accessibility.json",
    JSON.stringify(audits, null, 2),
  );
  console.log(
    "Cleanup Chromium passed: configurable roots persist; build discovery; preview/cancel; wrong and correct typed confirmation; actual fixture deletion; history; desktop/mobile; accessibility.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
