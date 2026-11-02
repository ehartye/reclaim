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

**Scan coverage** puts read/count problems first, groups expected exclusions and protections in expandable lists, and separates cache-save warnings. Recorded sample counts are not totals when a list is truncated. Older partial reports say **Results available** without claiming complete coverage; excluded contents still leave full-folder sizes as lower bounds, and cached sizes remain estimates. The optional folder cache retains at most 25,000 compact records within 8 MiB; uncached branches are recounted.

**Quick scan** uses complete dated totals for previously measured branches at or below the threshold, skipping their child directories. Own-directory creation/write metadata is checked before reuse. Deeper changes can leave these timestamps unchanged, so reused branches and containing totals remain explicitly **estimated**, with their source date. Quick totals can be stale in either direction. Uncheck Quick scan for a fresh recount. Lowering the result threshold after a quick scan can require another scan to expose previously pruned descendants.

Expand a branch to see qualifying child folders. **Inspect files** loads current individual-file metadata recursively within that selected branch, only after you request it. Results are paged (100 by default, at most 200 per request), with a 15-second inspection budget; choose a narrower branch after a timeout. File listings may differ from recorded totals because files can change. Inspection does not read contents, verify duplicates or delete files.

Choose **Git-ignored folders** under **Folder category** to find ignored directories strictly above the MB threshold. The operation checks Git's current effective ignore rules, including nested rules, repository excludes and global excludes, and shows the matching rule and repository. It uses the selected scan's recorded sizes, lists only outermost matches and remembers the operation and threshold in this browser. After changing the threshold, choose **Run ignored-folder check**. Run a fresh folder scan when current sizes or fuller coverage are needed. Git inspection has a 10,000-candidate limit and a time budget; errors and limited coverage remain visible.

Ignored data can include local settings, source assets, save data and Reclaim reports. Only recognized generated folders offer **Review cleanup**; other results remain **Review only**. Unreal native-project `Intermediate` folders are supported with project/source evidence and fresh tracked-file, link and content checks. Unreal `Build` inputs, `Saved` data, plugin/engine binaries and Zen storage are not made disposable by this operation.

**Routines** is available for both folder inventories and older full-file reports. Its compact comparison explains each routine, the next action and the concrete risk beside its **Recorded size**. Select a routine name to expand its decision and matching folders directly below that row; all rows start collapsed. Each folder retains its own **Review cleanup**, guidance or **Review only** restriction. **Review folders** opens the list without preparing cleanup.

Open **Review settings** to change the minimum size, age hint or project roots. Defaults are strictly greater than **500 MB**, with age hints off. **Save preset** retains settings for later sessions and clears only that routine’s result; **Run routine check** explicitly checks the edited draft. Compact **Check routine**, **Try again** and **Check again** use saved settings. Unsaved edits must be saved or resolved with **Use saved settings** before switching routines or starting a saved-setting check; repeat the intended action afterward. Detailed check/source dates, coverage, original boundaries and full diagnostics are under **Evidence and coverage**. Owner instructions and qualified commands are under **Guidance and sources**.

Choose **Run all** to check every routine sequentially with its saved settings and the selected report. Save edited controls or choose **Use saved settings** first. The comparison fills progressively, keeps failures and settings problems visible, and sorts known recorded sizes largest first. Select a row to inspect its retained candidates without another request. **Stop after current routine** lets the current check finish and leaves the rest not run. Leaving Routines or changing reports ends the queue; returning does not resume it.

Recorded size is each routine's logical scope size, with unknown sizes, estimates and incomplete amounts labeled beside it. **No matches under saved filters** does not establish zero opportunity. Rows can overlap, so there is no combined total. Without a real report, size evidence stays unknown. Run all does not scan, measure, save settings or prepare cleanup. Current progress and exceptions stay visible; **Batch details** contains the full breakdown. Cleanup review remains individual after the batch settles; each result keeps its own five-minute evidence deadline. Expired results remain visible with **Check again** and their reason. An individual rerun or preset save replaces or clears only that routine's result.

Routines distinguish **In-app review**, **Guided maintenance** and **Review only** using current candidate evidence. Risk describes what could be lost, affected or need restoring; recovery cost in supporting evidence describes rebuilding expense and is not a safety rating. Recognized project output can use the existing fresh preview and exact confirmation flow. npm, pip, NuGet, Gradle, Unreal DDC/Zen and other tool-managed stores require their own role and scope evidence; they do not become generic folder deletions. Guidance can describe or copy a qualified command for you to review and run yourself. Its scope, effects, mutation warning and optionality stay beside **Copy command**. Reclaim never executes maintenance commands or opens an operating-system cleanup tool automatically. Unknown activity or store roles keep guidance documentation-only.

Parent and child totals overlap and must not be added together. Tree sizes are logical file-entry lengths; hardlinked names can count more than once. They are not a promise of physical space recovery. Fresh incomplete totals are lower bounds for counted entries; mixed Quick estimates are not lower bounds. CSV uses the scan's saved threshold and labels its coverage/estimate basis. Reports, settings and scoped folder caches stay under `.reclaim/`.

**Review cleanup** on a build/dependency/worktree hint starts a fresh eligibility inspection using the existing cleanup engine. Names and old totals alone never establish that deletion is safe. Supported generated folders require project/restoration evidence; tracked files, protected application/data paths, filesystem links, cloud/offline objects and unsafe Git states remain blocked. The preview shows exact paths, current logical size, restoration steps and an exact typed confirmation phrase. Previews expire after five minutes and are single-use. Changed targets require a new preview. Permanent deletion bypasses the Recycle Bin; close the owning application and builds first. Generic caches and arbitrary source folders do not gain deletion rights.

Worktree cleanup uses `git worktree remove` without force and retains branches. Main, locked or dirty worktrees, unknown ignored content, submodules, hidden index flags and unique commits without a preserving reference are blocked. Partial removal and interrupted operations are recorded for inspection. A known cleanup change warns that the saved tree needs refreshing; dated totals are not silently treated as current.

Previous full-file reports remain readable in History with their original recommendations, map, duplicate evidence, review queue, resolved/dismissed dispositions and Development tools. These compatibility views retain their earlier file/read budgets; those budgets do not cap the foundational folder scan. Existing saved reports and review selections are preserved. Marking an item resolved is bookkeeping and does not delete data or measure recovered storage.

The service binds to loopback and protects writes with its existing Host/Origin checks and a per-session token. Malformed requests receive bounded errors without ending the service. Receipt limits are 15 seconds for headers and 30 seconds for receiving a request, with five-second keep-alive; a fully received operation can continue beyond the receipt deadline. There is no telemetry or external analysis service. Links, reparse points, offline/cloud placeholders and protected drive-root system folders are skipped; OneDrive is excluded by default. Long and Unicode paths are supported. Filesystem observations are not transactional snapshots.

The fixture-only [cleanup identity](docs/experiments/cleanup-identity-qualification.md) and [owner-lifetime](docs/experiments/data-owner-lifetime.md) experiments add no production permission or state-store lock. The measured cleanup strategies were Invalidated; the owner-reference candidate is Partial. Existing cleanup path-race and multi-instance state limitations remain open while the native qualification gates are unmet.

```powershell
npm test        # native filesystem, worker, cache, API and accounting checks
npm run test:ui # headless Chromium workflows, layout and accessibility
```

Install Chromium on a fresh test machine with `npx playwright install chromium`. Automated tests validate paths without opening Explorer, stub launch behavior, and reject unintercepted folder-opening requests. Screenshots and receipts go under ignored `review/`.

See [Architecture](docs/architecture.md) for the service, scanning and cleanup boundaries. Local reports, settings, logs, screenshots and temporary files are excluded from version control. Before sharing exported reports, review them for personal paths and filenames.
