import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
const temp = await mkdtemp(path.join(tmpdir(), "reclaim-browser-")),
  root = path.join(temp, "My workspace");
await mkdir(path.join(root, "private"), { recursive: true });
await mkdir(path.join(root, "Documents"));
await writeFile(path.join(root, "private", "keep.txt"), "private");
await writeFile(path.join(root, "Documents", "file.txt"), "file");
const app = await createApp({
  dataDir: path.join(temp, "state"),
  revealFolder: async () => {
    throw new Error("Tests must intercept desktop launches.");
  },
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const base = `http://127.0.0.1:${app.server.address().port}`;
async function scan() {
  const before = app.state.scans.length;
  await page.getByRole("button", { name: "New scan", exact: true }).click();
  await page.getByLabel("Folder path", { exact: true }).fill(root);
  await page.getByLabel("Folder size greater than", { exact: true }).fill("0");
  await page.getByLabel("Quick scan", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect
    .poll(() => app.state.scans.length, { timeout: 15000 })
    .toBe(before + 1);
  await expect(page.locator(".folder-tree-row")).toHaveCount(1);
}
try {
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "No folder scans yet", exact: true }),
  ).toBeVisible();
  await scan();
  await page
    .getByRole("button", { name: "Expand My workspace", exact: true })
    .click();
  let reveal;
  await page.route("**/api/reveal", async (r) => {
    reveal = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  await page
    .getByRole("button", { name: "Open folder Documents", exact: true })
    .click();
  expect(reveal).toEqual({
    scanId: app.state.scans[0].id,
    path: path.join(root, "Documents"),
  });
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Folder requested in your file manager" }),
  ).toBeVisible();
  await page.unroute("**/api/reveal");
  await page.route("**/api/reveal", (r) =>
    r.fulfill({ status: 400, json: { error: "Folder launch rejected" } }),
  );
  await page
    .getByRole("button", { name: "Open folder Documents", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Folder launch rejected" }),
  ).toBeVisible();
  for (const [format, label] of [
    ["json", "Full report (.json)"],
    ["csv", "Spreadsheet (.csv)"],
  ]) {
    await page
      .getByRole("button", { name: "Export report", exact: true })
      .click();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const download = await pending,
      body = await readFile(await download.path(), "utf8");
    if (format === "json") {
      const parsed = JSON.parse(body);
      expect(parsed.scan.directories.length).toBe(3);
      expect(parsed.scan.findings).toBeUndefined();
    } else {
      expect(body).toContain("Recursive logical bytes");
      expect(body).toContain("Documents");
    }
  }
  await page.route("**/api/scans/*/report.json", (r) =>
    r.fulfill({ status: 404, json: { error: "Report unavailable" } }),
  );
  await page
    .getByRole("button", { name: "Export report", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Full report (.json)", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Report unavailable" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Scan settings", exact: true })
    .click();
  await page.getByLabel("Exclusions", { exact: true }).fill("private\nignored");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Scan settings saved" }),
  ).toBeVisible();
  await scan();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(2);
  await expect(page.getByText("Coverage changed; no comparison")).toBeVisible();
  await page
    .getByRole("button", { name: "Scan settings", exact: true })
    .click();
  await page.getByLabel("Exclusions", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Scan settings saved" }),
  ).toBeVisible();
  await scan();
  await writeFile(
    path.join(root, "Documents", "new.bin"),
    Buffer.alloc(1024 ** 2),
  );
  await scan();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("+1 MB since previous")).toBeVisible();
  await page.locator(".history-row").first().click();
  for (const [width, height] of [
    [1440, 1050],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
    await page.screenshot({
      path: `review/current-folders-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  console.log(
    "Current folder browser passed: reveal success/failure, JSON/CSV downloads, recoverable export failure, exclusions, history comparison, desktop/mobile axe.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
