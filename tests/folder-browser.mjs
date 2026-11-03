import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, open, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
const temp = await mkdtemp(path.join(tmpdir(), "reclaim-folder-browser-")),
  root = path.join(temp, "search area");
async function sized(file, size) {
  await mkdir(path.dirname(file), { recursive: true });
  const h = await open(file, "w");
  try {
    await h.truncate(size);
  } finally {
    await h.close();
  }
}
await sized(path.join(root, "alpha", "one"), 300000000);
await sized(path.join(root, "alpha", "two"), 300000000);
await sized(path.join(root, "alpha", ".git"), 20);
await sized(path.join(root, "alpha", "deep", "bit"), 100);
await sized(path.join(root, "beta", "node_modules", "one"), 550000000);
await writeFile(path.join(root, "beta", "package.json"), "{}");
await writeFile(path.join(root, "beta", "package-lock.json"), "{}");
await sized(path.join(root, "beta", "node_modules", "nested", "deep.bin"), 1);
await sized(path.join(root, "exact500", "one"), 500000000);
await sized(path.join(root, "small", "nested", "one"), 100);
for (let i = 0; i < 55; i++)
  await sized(path.join(root, `tiny-${i}`, "one"), 1);
for (let i = 0; i < 101; i++)
  await sized(path.join(root, "beta", "node_modules", `file-${i}`), 1);
const app = await createApp({
  dataDir: path.join(temp, "state"),
  revealFolder: async () => {
    throw new Error("Tests must not open desktop folders.");
  },
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage(),
  errors = [],
  requests = [];
page.setDefaultTimeout(5000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.url().includes("/api/folders/inspect")) requests.push(r.postDataJSON());
});
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByRole("button", { name: "New scan", exact: true }).click();
  await expect(page.getByLabel("Operation", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Quick scan", { exact: true })).toBeChecked();
  await page.getByLabel("Folder path", { exact: true }).fill(root);
  await page.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Folders", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".folder-tree-row")).toHaveCount(1);
  expect(requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "Expand search area", exact: true })
    .click();
  await expect(page.locator(".folder-tree-row")).toHaveCount(3);
  await expect(page.locator(".folder-size-results")).not.toContainText(
    "exact500",
  );
  await expect(page.locator(".folder-size-results")).not.toContainText(
    "nested",
  );
  await page.getByRole("button", { name: "Expand beta", exact: true }).click();
  await expect(page.locator(".folder-tree-row")).toHaveCount(4);
  await page
    .getByLabel("Folder category", { exact: true })
    .selectOption("dependencies");
  await expect(page.locator(".folder-tree-row")).toHaveCount(3);
  await expect(
    page
      .locator(".folder-tree-row")
      .filter({ has: page.locator("strong").filter({ hasText: /^beta$/ }) }),
  ).toContainText("Ancestor");
  expect(requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "Inspect files in node_modules", exact: true })
    .click();
  expect(requests).toHaveLength(1);
  await expect(page.locator(".folder-file-row")).toHaveCount(100);
  await page
    .getByRole("button", { name: "Show more files", exact: true })
    .click();
  await expect(page.locator(".folder-file-row")).toHaveCount(103);
  await expect(page.locator(".folder-file-list")).toContainText("one");
  await expect(page.locator(".folder-file-list")).toContainText(
    path.join("nested", "deep.bin"),
  );
  expect(requests[1].offset).toBe(100);
  await page
    .getByRole("button", { name: "Hide files in node_modules", exact: true })
    .click();
  expect(requests[0].path).toBe(path.join(root, "beta", "node_modules"));
  await page
    .getByLabel("Folder category", { exact: true })
    .selectOption("worktrees");
  await page.getByLabel("Folder total greater than", { exact: true }).fill("0");
  await expect(page.locator(".folder-tree-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Expand alpha", exact: true }).click();
  await expect(page.locator(".folder-tree-row")).toHaveCount(3);
  await expect(
    page
      .locator(".folder-tree-row")
      .filter({ has: page.locator("strong").filter({ hasText: /^deep$/ }) }),
  ).toHaveCount(1);
  await page
    .getByLabel("Folder total greater than", { exact: true })
    .fill("500");
  await page.getByLabel("Folder category", { exact: true }).selectOption("all");
  await page.getByLabel("Search folder paths", { exact: true }).fill("alpha");
  await expect(page.locator(".folder-tree-row")).toHaveCount(2);
  await page.getByLabel("Search folder paths", { exact: true }).fill("");
  await page
    .getByLabel("Folder total greater than", { exact: true })
    .fill("400");
  await expect(
    page.locator(".folder-tree-row").filter({ hasText: "exact500" }),
  ).toHaveCount(1);
  const audit = async () => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    ).toEqual([]);
  };
  await audit();
  await page.screenshot({
    path: "review/folder-totals-desktop.png",
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
    path: "review/folder-totals-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator(".folder-tree-row")).toHaveCount(1);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".history-row").click();
  await expect(page.locator(".folder-tree-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Expand search area", exact: true })
    .click();
  await page.getByLabel("Folder total greater than", { exact: true }).fill("0");
  await expect(page.locator(".folder-tree-row")).toHaveCount(51);
  await page
    .getByRole("button", {
      name: "Show 9 more folders in search area",
      exact: true,
    })
    .click();
  await expect(page.locator(".folder-tree-row")).toHaveCount(60);
  await page
    .getByRole("button", { name: "Scan folder totals", exact: true })
    .click();
  await page
    .getByLabel("Folder size greater than", { exact: true })
    .fill("500");
  await page.getByLabel("Quick scan", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect.poll(() => app.state.scans.length, { timeout: 15000 }).toBe(2);
  expect(app.state.scans[0].operation).toBe("folder-sizes");
  await expect(page.locator(".folder-tree-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Scan folder totals", exact: true })
    .click();
  await expect(page.getByLabel("Quick scan", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect.poll(() => app.state.scans.length, { timeout: 15000 }).toBe(3);
  await expect(
    page.getByText("Estimated from saved branch totals.", { exact: true }),
  ).toBeVisible();
  // A category includes the selected root itself, and never an outside ancestor.
  const modulesRoot = path.join(root, "beta", "node_modules");
  await page.getByRole("button", { name: "New scan", exact: true }).click();
  await page.getByLabel("Folder path", { exact: true }).fill(modulesRoot);
  await page.getByLabel("Folder size greater than", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect.poll(() => app.state.scans.length, { timeout: 15000 }).toBe(4);
  await expect(page.locator(".folder-scope code")).toHaveText(modulesRoot);
  await page
    .getByLabel("Folder category", { exact: true })
    .selectOption("dependencies");
  await expect(page.locator(".folder-total-summary")).toContainText(
    "2 matching folders",
  );
  await page
    .getByRole("button", { name: "Expand node_modules", exact: true })
    .click();
  await expect(page.locator(".folder-tree-row")).toHaveCount(2);
  await expect(
    page.locator(".folder-tree-row .large-folder-path > strong"),
  ).toHaveText(["node_modules", "nested"]);

  // Late file responses must never replace a newer inspection of the same branch.
  let firstInspect,
    inspectionCount = 0;
  await page.route("**/api/folders/inspect", async (route) => {
    inspectionCount++;
    if (inspectionCount === 1) {
      firstInspect = route;
      return;
    }
    await route.fulfill({
      json: {
        path: modulesRoot,
        files: [
          { path: path.join(modulesRoot, "new.bin"), size: 20, mtimeMs: 0 },
        ],
        nextOffset: null,
        notices: [],
      },
    });
  });
  await page
    .getByRole("button", { name: "Inspect files in node_modules", exact: true })
    .click();
  await expect.poll(() => inspectionCount).toBe(1);
  await page
    .getByRole("button", { name: "Hide files in node_modules", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect files in node_modules", exact: true })
    .click();
  await expect(page.locator(".folder-file-list")).toContainText("20 B");
  await firstInspect.fulfill({
    json: {
      path: modulesRoot,
      files: [
        { path: path.join(modulesRoot, "old.bin"), size: 10, mtimeMs: 0 },
      ],
      nextOffset: null,
      notices: [],
    },
  });
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".folder-file-list")).toContainText("20 B");
  await expect(page.locator(".folder-file-list")).not.toContainText("old.bin");
  await expect(page.locator(".folder-file-list")).not.toContainText("�");
  await page.unroute("**/api/folders/inspect");

  // Name hints open the existing fresh eligibility preview and typed confirmation.
  let prepareRequest;
  page.on("request", (r) => {
    if (r.url().includes("/api/cleanup/prepare"))
      prepareRequest = r.postDataJSON();
  });
  await page
    .getByRole("button", {
      name: "Review cleanup for node_modules",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Confirm permanent deletion" }),
  ).toContainText("npm ci");
  expect(prepareRequest).toEqual({
    scanId: app.state.scans[0].id,
    directoryPath: modulesRoot,
  });
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await stat(path.join(modulesRoot, "one"))).size).toBe(550000000);
  await expect(
    page
      .locator(".folder-tree-row")
      .filter({ has: page.locator("strong").filter({ hasText: /^nested$/ }) })
      .getByRole("button", { name: /Review cleanup/ }),
  ).toHaveCount(0);

  const snapshotWarning = page.getByText(
    "Cleanup changed this search area after the scan.",
    { exact: true },
  );
  app.state.cleanups.unshift({
    id: "outside",
    path: modulesRoot + "-other",
    status: "deleted",
    kind: "generated",
    deletedFiles: 1,
    deletedBytes: 1,
    startedAt: new Date(Date.now() + 1000).toISOString(),
    completedAt: new Date(Date.now() + 1000).toISOString(),
  });
  await expect(snapshotWarning).toHaveCount(0);
  app.state.cleanups.unshift({
    id: "inside",
    path: path.join(modulesRoot, "nested"),
    status: "deleted",
    kind: "generated",
    deletedFiles: 1,
    deletedBytes: 1,
    startedAt: new Date(Date.now() + 2000).toISOString(),
    completedAt: new Date(Date.now() + 2000).toISOString(),
  });
  await expect(snapshotWarning).toBeVisible();
  await page
    .getByRole("button", { name: "Scan settings", exact: true })
    .click();
  await expect(
    page.getByLabel("Maximum files per legacy full scan", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".settings-note")
      .filter({ hasText: "Windows system folders" }),
  ).toContainText("Folder totals scans have no file or directory cap");
  expect(errors).toEqual([]);
  console.log(
    "Folder tree Chromium passed: hierarchy, pruning, filters, on-demand files, quick/fresh, history, desktop/mobile accessibility; no desktop launch.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
