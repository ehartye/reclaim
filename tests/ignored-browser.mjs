import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";

const temp = await mkdtemp(path.join(tmpdir(), "reclaim-ignored-ui-"));
const root = path.join(temp, "project");
await mkdir(root);
execFileSync("git", ["-C", root, "init", "-b", "main"], { windowsHide: true });
await writeFile(
  path.join(root, ".gitignore"),
  "Intermediate/\nsaved-data/\nexact/\n",
);
await writeFile(
  path.join(root, "Game.uproject"),
  JSON.stringify({ Modules: [{ Name: "Game" }] }),
);
await mkdir(path.join(root, "Source"));
for (const [name, size] of [
  ["Intermediate", 600000000],
  ["saved-data", 550000000],
  ["exact", 500000000],
]) {
  await mkdir(path.join(root, name));
  const handle = await open(path.join(root, name, "fixture.bin"), "w");
  await handle.truncate(size);
  await handle.close();
}
const app = await createApp({
  dataDir: path.join(temp, "state"),
  revealFolder: async () => {
    throw new Error("Tests must not open folders.");
  },
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByRole("button", { name: "New scan", exact: true }).click();
  await page.getByLabel("Folder path", { exact: true }).fill(root);
  await page.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect(page.getByLabel("Folder category", { exact: true })).toBeVisible(
    { timeout: 15000 },
  );
  await page
    .getByLabel("Folder category", { exact: true })
    .selectOption("ignored");
  await expect(page.locator(".ignored-folder-row")).toHaveCount(2);
  await expect(page.locator(".ignored-operation")).toContainText(
    ".gitignore:1",
  );
  await expect(
    page.locator(".ignored-folder-row").filter({ hasText: "saved-data" }),
  ).toContainText("Review only");
  await expect(
    page
      .locator(".ignored-folder-row")
      .filter({ hasText: "saved-data" })
      .getByRole("button", { name: /Review cleanup/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `Review cleanup for ${path.join(root, "Intermediate")}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Confirm permanent deletion" }),
  ).toContainText("Unreal Engine");
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByLabel("Search folder paths", { exact: true })
    .fill("Intermediate");
  await expect(page.locator(".ignored-folder-row")).toHaveCount(1);
  await page.getByLabel("Search folder paths", { exact: true }).fill("");
  await page
    .getByLabel("Folder total greater than", { exact: true })
    .fill("700");
  await expect(page.locator(".ignored-operation")).toContainText(
    "The threshold changed",
  );
  await expect(
    page.getByRole("button", {
      name: `Review cleanup for ${path.join(root, "Intermediate")}`,
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Run ignored-folder check", exact: true })
    .click();
  await expect(page.locator(".ignored-folder-row")).toHaveCount(0);
  await page
    .getByLabel("Folder total greater than", { exact: true })
    .fill("500");
  await page
    .getByRole("button", { name: "Run ignored-folder check", exact: true })
    .click();
  await expect(page.locator(".ignored-folder-row")).toHaveCount(2);
  await page.reload();
  await expect(page.getByLabel("Folder category", { exact: true })).toHaveValue(
    "ignored",
  );
  await expect(
    page.getByLabel("Folder total greater than", { exact: true }),
  ).toHaveValue("500");
  await expect(page.locator(".ignored-folder-row")).toHaveCount(2);
  const audit = async () => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
  };
  await audit();
  await page.screenshot({
    path: "review/ignored-folders-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await audit();
  await page.screenshot({
    path: "review/ignored-folders-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Git-ignored operation: rules, review-only data, Unreal confirmation, thresholds, saved preference, desktop/mobile and accessibility passed.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
