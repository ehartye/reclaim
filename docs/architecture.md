# Architecture

Reclaim is a Windows application with a React interface and a Node.js service bound to loopback. The service stores reports, settings, review state and caches in the ignored `.reclaim/` directory. It does not send filesystem data to an external analysis service.

## Folder inventory

The foundational scan records recursive logical folder totals without retaining an individual record for every file. Native Windows helpers enumerate metadata; worker jobs keep the HTTP service responsive. There is no fixed file-count cap on this scan. Exclusions, inaccessible locations, links, cloud placeholders and cancellation affect coverage and remain visible in the report.

A folder tree shows qualifying branches above a configurable threshold. Parent totals include their descendants and must not be added to child totals. Logical file-entry sizes can count shared hardlinks more than once and do not guarantee physical space recovery.

Quick scans may reuse complete dated totals for small branches. Reused totals are estimates because changes deeper in a branch can leave its own timestamps unchanged. Fresh scans recount accessible metadata. Individual-file inspection is a separate, on-demand operation with pagination and a time budget.

## Git-ignored folder operation

`POST /api/folders/ignored` accepts a known scan ID and a strict minimum byte threshold. It filters the saved directory inventory, checks current directory identity and repository ownership, and batches NUL-delimited paths through `git check-ignore --stdin -z --verbose`. Git supplies ignore precedence, negation and rule provenance. Git metadata, excluded paths and linked directories are omitted; unavailable entries and Git failures have explicit coverage. The operation is limited to 10,000 candidate directories with an inspection budget, separate from the uncapped foundational scan.

Only outermost matching directories are returned, preventing parent/child double counting. Ignore rules are current observations; logical sizes remain dated scan evidence. A preliminary generated-folder description controls whether a row can request cleanup review, with protected or unknown outputs remaining review-only. Ignore status never authorizes deletion. The browser remembers this operation and its threshold; rerunning refreshes Git evidence, while a fresh foundational scan refreshes size evidence.

## Repeatable cleanup routines

The shared routine catalog describes named discovery operations, execution modes, recovery costs, evidence links and versioned parameter defaults. `GET /api/routines` returns definitions, validated saved presets and invalid-preset diagnostics. The interface displays retained invalid parameters and requires a corrected, validated save before running. `POST /api/routines/presets` persists a validated preset while retaining invalid saved data for correction. Default minimum size is 500,000,000 bytes, compared strictly; age hints are off and never establish that data is unused.

`POST /api/routines/run` accepts a routine ID, review parameters and an optional known scan ID. It evaluates recorded logical sizes and current project/role evidence, preserving unknown sizes, estimate dates and partial coverage. Cache roles, managed stores and global maintenance routines remain separate from generated project output. Guidance is qualified against observed scope and activity; unresolved activity yields documentation-only steps. Commands are returned as reviewable text and never executed by the service or interface. DDC and Zen storage have separate roles and no generic purge action.

Each run stores bounded, expiring server-owned candidate IDs. `POST /api/routines/candidates/prepare` accepts only a run ID and candidate ID, rechecks stored parameters and current eligibility, then delegates eligible generated/worktree candidates to the existing cleanup preview. The browser cannot submit a target path or an execution mode through this route. Preset changes invalidate prior runs; changed controls disable preparation and saving clears the visible results. Guided and review-only candidates never offer in-app preparation.

The Routines interface is available beside Folders for both current and legacy report shapes. It persists parameters through the service, labels historical sizes and recovery costs, and exposes owner documentation before and after discovery. The cleanup dialog accepts an optional preparation function for routine IDs; legacy callers retain their original `/api/cleanup/prepare` behavior. Execution remains the existing token-bound preview/confirmation operation.

`shared/routine-batch.ts` owns the foreground comparison lifecycle. Run all refreshes the catalog, clones definitions, validated/default presets, invalid-preset records and the selected scan ID, and submits explicit captured parameters through the existing single-run API in catalog order. One request is pending at a time. Invalid presets become Needs settings without a request; individual failures remain visible while later checks continue without retries. Stop after current routine waits for the response and marks unstarted rows not run. Generation and report-context guards suppress obsolete responses and scheduling after navigation or disposal. There is no batch endpoint, background job or reload persistence.

The browser retains one latest result per routine in the current report context. Summaries count outermost candidate scopes, retain known logical bytes alongside unknown counts, estimate/incomplete indicators, coverage, check dates and size provenance, and never add rows into a grand total. No real report means unknown size evidence. Selection does not rerun discovery or refresh proof: each preparation deadline derives from its run's check time, capped at five minutes after receipt; malformed dates disable preparation. A preset save clears only that routine's result, and an individual rerun replaces only its own. While a batch settles, browsing stays available and saves, individual runs and preparation are disabled. Server freshness, identity, parameters and existing cleanup protections remain authoritative.

## Cleanup evidence

Generated folders and worktrees are candidates until a fresh inspection verifies eligibility. A name, age or recorded size alone does not authorize deletion. Supported generated folders require project and restoration evidence. Protected paths, tracked files, links, cloud placeholders and unsafe Git states are blocked.

The cleanup preview shows exact targets, current size, restoration instructions and an exact typed confirmation phrase. Previews expire after five minutes, are single-use and are invalidated by relevant changes. Deletion is permanent. Worktree cleanup uses `git worktree remove` without force and retains branches. Receipts record successful, partial and interrupted outcomes.

Fresh allocation measurements can estimate exclusive allocated bytes while excluding known shared hardlinks. Directory metadata and alternate streams are outside that estimate, and the result is not a promise of recovered free space. Age evidence reflects observed metadata activity rather than exact generation dates or last use.

## Service and verification

State-changing requests require same-origin validation and a per-session token. Scan, measurement and cleanup jobs have lifecycle and concurrency controls. Saved reports remain readable; manual review dispositions do not claim that files were deleted.

`npm test` exercises native helpers, filesystem fixtures, background jobs, accounting, persistence and HTTP controls. `npm run test:ui` runs headless Chromium workflows with layout and accessibility checks. Folder-opening tests validate or stub requests so automated verification does not launch Explorer. All deletion tests use disposable fixtures.
