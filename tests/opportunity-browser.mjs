import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  link,
  utimes,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
const temp = await mkdtemp(path.join(tmpdir(), "reclaim-productive-browser-")),
  root = path.join(temp, "projects"),
  modules = path.join(root, "old-project", "node_modules"),
  build = path.join(root, "active-project", "dist"),
  dataDir = path.join(temp, "state");
await mkdir(modules, { recursive: true });
await mkdir(build, { recursive: true });
await mkdir(path.join(root, "keepers"));
await writeFile(path.join(root, "old-project", "package.json"), "{}");
await writeFile(
  path.join(root, "old-project", "package-lock.json"),
  '{"lockfileVersion":3}',
);
await writeFile(path.join(modules, ".package-lock.json"), "{}");
await writeFile(
  path.join(modules, "packages.bin"),
  Buffer.alloc(2 * 1024 ** 2, 7),
);
await writeFile(path.join(modules, "shared.bin"), Buffer.alloc(1024 ** 2, 8));
await link(
  path.join(modules, "shared.bin"),
  path.join(root, "keepers", "shared.bin"),
);
await writeFile(
  path.join(root, "active-project", "package.json"),
  '{"scripts":{"build":"vite build"}}',
);
await writeFile(path.join(build, "bundle.js"), Buffer.alloc(1024 ** 2, 9));
await utimes(
  path.join(build, "bundle.js"),
  new Date("2020-01-01"),
  new Date("2020-01-01"),
);
if (process.platform === "win32")
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$o=[Console]::ReadLine()|ConvertFrom-Json;$d=[DateTime]::Parse('2020-01-01T00:00:00Z').ToUniversalTime();Get-ChildItem -LiteralPath $o.path -Recurse -Force|ForEach-Object {$_.CreationTimeUtc=$d;$_.LastWriteTimeUtc=$d};$r=Get-Item -LiteralPath $o.path;$r.CreationTimeUtc=$d;$r.LastWriteTimeUtc=$d",
    ],
    { input: JSON.stringify({ path: modules }) + "\n", windowsHide: true },
  );
const app = await createApp({
  dataDir,
  revealFolder: async () => {
    throw new Error("Browser tests must not open desktop folders.");
  },
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`,
  initial = await fetch(base + "/api/state").then((r) => r.json());
const send = (url, body) =>
  fetch(base + "/api/" + url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": initial.token,
    },
    body: JSON.stringify(body),
  });
await send("settings", {
  developmentRoots: [root],
  opportunityMinBytes: 1024 ** 2,
  opportunityAgeDays: 30,
});
await send("scans", { root, minimumBytes: 1 });
for (let i = 0; i < 100; i++) {
  if (app.state.scans.length) break;
  await new Promise((r) => setTimeout(r, 30));
}
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1020 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage(),
  errors = [],
  audits = [];
page.on("pageerror", (e) => errors.push(e.message));
async function audit(label) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  audits.push({ label, violations });
  expect(
    violations.filter((v) => ["serious", "critical"].includes(v.impact)),
  ).toEqual([]);
}
try {
  await page.goto(base);
  await page.route("**/api/development", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.locator(".development-target")).toHaveCount(2);
  await expect(
    page.getByText(
      "Quick look — recorded estimates; current discovery continues",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(".gain-recorded")).toContainText("3 MB");
  await audit("productive recorded estimates desktop");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "review/productive-recorded-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByText("Discovery complete for these folder rules", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Productive scenario", { exact: true })
    .selectOption("old-dependencies");
  await expect(page.locator(".development-target")).toHaveCount(
    process.platform === "win32" ? 1 : 0,
  );
  if (process.platform === "win32") {
    await page
      .getByLabel("Generated activity older than", { exact: true })
      .fill("90");
    await page.getByLabel("Minimum estimated gain", { exact: true }).focus();
    await page
      .getByRole("button", { name: "Measure size & activity", exact: true })
      .click();
    await expect(page.locator(".activity-badge.old")).toContainText("90 days", {
      timeout: 15000,
    });
    await expect(page.locator(".gain-primary")).toContainText("2 MB");
    await expect(page.locator(".measurement-limitation")).toContainText("1 MB");
    await expect(page.locator(".candidate-gain")).toContainText(
      "Exclusive allocated estimate",
    );
    await audit("productive verified old dependencies desktop");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: "review/productive-verified-desktop.png",
      fullPage: true,
    });
    // Minimum gain hides known-small folders, and persisted filters do not erase known target authorization.
    await page.getByLabel("Minimum estimated gain", { exact: true }).fill("4");
    await page.getByLabel("Productive scenario", { exact: true }).focus();
    await expect(page.locator(".development-target")).toHaveCount(0);
    await page.getByLabel("Minimum estimated gain", { exact: true }).fill("1");
    await page.getByLabel("Productive scenario", { exact: true }).focus();
    await expect(page.locator(".development-target")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Review deletion", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Confirm permanent deletion" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await readFile(path.join(modules, "packages.bin"))).length).toBe(
      2 * 1024 ** 2,
    );
  }
  await page
    .getByLabel("Productive scenario", { exact: true })
    .selectOption("old-builds");
  await expect(page.locator(".development-target")).toHaveCount(0);
  await expect(page.getByText(/folders show recent activity/)).toBeVisible();
  await page
    .getByLabel("Productive scenario", { exact: true })
    .selectOption("largest");
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Productive mobile overflow");
  await audit("productive scenarios mobile");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "review/productive-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(
    page.getByLabel("Generated activity older than", { exact: true }),
  ).toHaveValue(process.platform === "win32" ? "90" : "30");
  if (process.platform === "win32") {
    await page
      .getByLabel("Productive scenario", { exact: true })
      .selectOption("old-dependencies");
    await page
      .getByRole("button", { name: "Review deletion", exact: true })
      .click();
    const phrase = await page
      .locator('label[for="delete-phrase"] strong')
      .innerText();
    await page.locator("#delete-phrase").fill(phrase);
    await page
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(
      page.getByText("Deleted permanently", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator(".development-target")).toHaveCount(0);
    await expect(page.locator(".gain-primary")).not.toContainText("2 MB");
  }
  expect(errors).toEqual([]);
  await writeFile(
    "review/productive-accessibility.json",
    JSON.stringify(audits, null, 2),
  );
  console.log(
    "Productive Chromium passed: saved estimates, old generated activity, shared allocation discount, minimum gain, persisted thresholds, confirmed deletion cancellation, recently-created outputs, desktop/mobile and accessibility.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
