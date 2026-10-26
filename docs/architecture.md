# Architecture

Reclaim is a Windows application with a React interface and a Node.js service bound to loopback. The service stores reports, settings, review state and caches in the ignored `.reclaim/` directory. It does not send filesystem data to an external analysis service.

## Folder inventory

The foundational scan records recursive logical folder totals without retaining an individual record for every file. Native Windows helpers enumerate metadata; worker jobs keep the HTTP service responsive. There is no fixed file-count cap on this scan. Exclusions, inaccessible locations, links, cloud placeholders and cancellation affect coverage and remain visible in the report.

A folder tree shows qualifying branches above a configurable threshold. Parent totals include their descendants and must not be added to child totals. Logical file-entry sizes can count shared hardlinks more than once and do not guarantee physical space recovery.

Quick scans may reuse complete dated totals for small branches. Reused totals are estimates because changes deeper in a branch can leave its own timestamps unchanged. Fresh scans recount accessible metadata. Individual-file inspection is a separate, on-demand operation with pagination and a time budget.

## Cleanup evidence

Generated folders and worktrees are candidates until a fresh inspection verifies eligibility. A name, age or recorded size alone does not authorize deletion. Supported generated folders require project and restoration evidence. Protected paths, tracked files, links, cloud placeholders and unsafe Git states are blocked.

The cleanup preview shows exact targets, current size, restoration instructions and an exact typed confirmation phrase. Previews expire after five minutes, are single-use and are invalidated by relevant changes. Deletion is permanent. Worktree cleanup uses `git worktree remove` without force and retains branches. Receipts record successful, partial and interrupted outcomes.

Fresh allocation measurements can estimate exclusive allocated bytes while excluding known shared hardlinks. Directory metadata and alternate streams are outside that estimate, and the result is not a promise of recovered free space. Age evidence reflects observed metadata activity rather than exact generation dates or last use.

## Service and verification

State-changing requests require same-origin validation and a per-session token. Scan, measurement and cleanup jobs have lifecycle and concurrency controls. Saved reports remain readable; manual review dispositions do not claim that files were deleted.

`npm test` exercises native helpers, filesystem fixtures, background jobs, accounting, persistence and HTTP controls. `npm run test:ui` runs headless Chromium workflows with layout and accessibility checks. Folder-opening tests validate or stub requests so automated verification does not launch Explorer. All deletion tests use disposable fixtures.
