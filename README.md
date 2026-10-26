# Reclaim

A local Windows utility for exploring folder sizes and reviewing disk cleanup. One foundational folder scan produces a tree; builds, dependencies, caches and worktrees are filters of that inventory. File inspection and verified cleanup run when requested.

Requires **Node.js 24+** and Windows PowerShell. No administrator access is needed.

```powershell
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4318**. After the first build, **Start-Reclaim.cmd** starts the local service; **Stop-Reclaim.cmd** gracefully stops it after active work finishes. `PORT` selects another port; development uses `npm run dev`.

Choose **Scan a folder**, select a search area and set a size threshold. The default is strictly greater than **500 MB (500,000,000 bytes)**. Results open in **Folders**, with a collapsed tree, largest children first, per-branch paging, exact bytes, search and category filters. Ancestors remain visible as context. Filters do not start separate scans or authorize deletion.

Foundational scans have **no fixed file or directory count cap**. They count metadata without reading file contents. A first scan or **Fresh** refresh must examine accessible descendant metadata to establish recursive totals. Incomplete totals cannot prove that a branch is small. Cancellation, inaccessible paths, exclusions and unsafe links/cloud objects remain visible in coverage.

**Quick scan** uses complete dated totals for previously measured branches at or below the threshold, skipping their child directories. Own-directory creation/write metadata is checked before reuse. Deeper changes can leave these timestamps unchanged, so reused branches and containing totals remain explicitly **estimated**, with their source date. Quick totals can be stale in either direction. Uncheck Quick scan for a fresh recount. Lowering the result threshold after a quick scan can require another scan to expose previously pruned descendants.

Expand a branch to see qualifying child folders. **Inspect files** loads current individual-file metadata recursively within that selected branch, only after you request it. Results are paged (100 by default, at most 200 per request), with a 15-second inspection budget; choose a narrower branch after a timeout. File listings may differ from recorded totals because files can change. Inspection does not read contents, verify duplicates or delete files.

Parent and child totals overlap and must not be added together. Tree sizes are logical file-entry lengths; hardlinked names can count more than once. They are not a promise of physical space recovery. Fresh incomplete totals are lower bounds for counted entries; mixed Quick estimates are not lower bounds. CSV uses the scan's saved threshold and labels its coverage/estimate basis. Reports, settings and scoped folder caches stay under `.reclaim/`.

**Review cleanup** on a build/dependency/worktree hint starts a fresh eligibility inspection using the existing cleanup engine. Names and old totals alone never establish that deletion is safe. Supported generated folders require project/restoration evidence; tracked files, protected application/data paths, filesystem links, cloud/offline objects and unsafe Git states remain blocked. The preview shows exact paths, current logical size, restoration steps and an exact typed confirmation phrase. Previews expire after five minutes and are single-use. Changed targets require a new preview. Permanent deletion bypasses the Recycle Bin; close the owning application and builds first. Generic caches and arbitrary source folders do not gain deletion rights.

Worktree cleanup uses `git worktree remove` without force and retains branches. Main, locked or dirty worktrees, unknown ignored content, submodules, hidden index flags and unique commits without a preserving reference are blocked. Partial removal and interrupted operations are recorded for inspection. A known cleanup change warns that the saved tree needs refreshing; dated totals are not silently treated as current.

Previous full-file reports remain readable in History with their original recommendations, map, duplicate evidence, review queue, resolved/dismissed dispositions and Development tools. These compatibility views retain their earlier file/read budgets; those budgets do not cap the foundational folder scan. Existing saved reports and review selections are preserved. Marking an item resolved is bookkeeping and does not delete data or measure recovered storage.

The service binds to loopback and protects writes with same-origin checks and a per-session token. There is no telemetry or external analysis service. Links, reparse points, offline/cloud placeholders and protected drive-root system folders are skipped; OneDrive is excluded by default. Long and Unicode paths are supported. Filesystem observations are not transactional snapshots.

```powershell
npm test        # native filesystem, worker, cache, API and accounting checks
npm run test:ui # headless Chromium workflows, layout and accessibility
```

Install Chromium on a fresh test machine with `npx playwright install chromium`. Automated tests validate paths without opening Explorer, stub launch behavior, and reject unintercepted folder-opening requests. Screenshots and receipts go under ignored `review/`.

See [Architecture](docs/architecture.md) for the service, scanning and cleanup boundaries. Local reports, settings, logs, screenshots and temporary files are excluded from version control. Before sharing exported reports, review them for personal paths and filenames.
