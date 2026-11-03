# Legacy interface removal inventory

## WP1 — retained backend and contracts

Only `folder-sizes` scans are accepted. Omitted operations normalize to that operation in both HTTP and scanner dispatch. Explicit retired operations receive HTTP 400 even while a scan is running. Current reports require folder sizing accounting version 2 and the folder-sizes operation; missing payloads receive 404 and unsupported payloads receive a recoverable 400. No report migration is performed.

| Removed implementation | Former consumers | Retained replacement |
| --- | --- | --- |
| `server/analysis.mjs` | Full-file scanner ranking and selected-byte calculation | Folder aggregation; no replacement ranking |
| Full enumeration and duplicate hashing in `server/scanner.mjs`; `server/windows-enumerate.ps1` | Full-file scan dispatch | `scanFolderSizes`, current native folder totals and inspection |
| `server/insights.mjs` | Finding enrichment on report retrieval | Current folder report retrieval, unchanged recorded values |
| `server/development.mjs` standalone discovery tail | Development and Quick discovery APIs | Routines use their existing typed discovery |
| Git, root normalization and generated-folder qualification in `server/development.mjs` | Cleanup, ignored folders, routines, app startup | Extracted unchanged to `server/project-discovery.mjs` |
| `server/opportunity-index.mjs`, `server/opportunity-index-worker.mjs` | Development Quick, intelligence API, scan-worker sidecars | No index creation; folder Quick cache remains |
| `server/opportunity-jobs.mjs`, `server/opportunity-advice.mjs` | Standalone measurement endpoints and development enrichment | Current routine probes and folder-measurement helpers remain |
| Opportunity-module import from `server/folder-cache.mjs` | Cleanup invalidation of Quick results | `shared/cleanup-changes.ts` contains the extracted path-overlap helper |
| Historical doubled-root normalization in `server/folder-accounting.mjs` | Report read adapter | Fresh accounting remains; unsupported old reports are rejected |
| Review normalization, dispositions and persistence in `server/app.mjs` | Review endpoint, finding CSV/JSON, finding cleanup completion | Canonical cleanup audit history remains |

Retired routes return 404 for GET and POST and cannot enqueue work: `/api/development`, `/api/development/quick`, `/api/intelligence`, `/api/intelligence/start`, `/api/measurements/start`, `/api/measurements/cancel`, `/api/review`. No compatibility adapter is registered. Legacy cleanup `targetId` and `findingId` bodies are rejected, including mixed bodies with current folder fields. Saved directory preparation and routine server-ID preparation remain. Reveal membership now consists of the report root and directory rows.

Removed scanner/settings keys: `minimumBytes`, `largeFileBytes`, `staleDays`, `duplicates`, `duplicateMinBytes`, `hashBudgetBytes`, `maxFiles`, `opportunityAgeDays`, `opportunityMinBytes`. Their consumers were full-file scanning/ranking, standalone discovery and planner filters. Supported settings are exclusions, cloud policy, development roots and folder minimum bytes; routine-specific parameters are independent and unchanged. On startup, stored settings pass through the supported-settings validator: retired keys are omitted in memory, supported values are validated and normalized using the existing input rules, and defaults fill missing supported fields. Startup does not write state; the next ordinary state save persists that reduced settings object. The service no longer exposes measurement jobs or reviews in state. Existing disk artifacts are not deleted by this package; the offline purge owns that work.

## Test migration

| Test artifact | Change and retained assertions |
| --- | --- |
| `current-only-api.test.mjs` | New route/operation containment, state/directory non-mutation, default folder scan, folder export, missing/unsupported report and scanner dispatch regressions |
| `api.test.mjs` | Convert full-file fixtures to folder reports; keep origin/token checks, invalid input, concurrent-start exclusion, exports, reveal membership/failure, persistence recovery and restart |
| `cleanup-api.test.mjs` | Convert development/finding preparation to saved-directory preparation; retain typed confirmation, replay rejection, on-disk deletion, audit persistence, busy gates and shutdown drain |
| `project-discovery.test.mjs` (formerly `development.test.mjs`) | Keep root normalization, generated evidence and Git qualification (local edits, ignored data, locks, unique commits and hidden edits); remove standalone discovery-only cases now covered by typed routine discovery |
| `scanner.test.mjs` | Keep exclusions, junction/ancestor boundaries, Unicode, long paths and active cancellation; remove duplicate hashing, finding ranking, file cap and finding-selection tests with their implementation |
| `folder-root-accounting.test.mjs` | Fresh root totals and API/CSV fidelity replace historical correction adapter coverage |
| `routines-api.test.mjs` | Current folder fixtures; assert obsolete settings/reviews absent while report payload, routines, preparation and cleanup remain covered |
| `http-containment.test.mjs`, data-owner sequential fixtures | Use supported folder minimum setting for body-abort and state-loss controls |
| Removed `insights.test.mjs`, `opportunity-api.test.mjs`, `opportunity-index.test.mjs`, `opportunity-jobs.test.mjs`, `opportunity-advice.test.mjs` | Exclusive retired enrichment, planner API/index/worker/advice tests; current cache, measurement, routine and cleanup suites retained |

The first TDD run of `current-only-api.test.mjs` failed all four cases against the baseline: retired endpoint returned 200, omitted operation produced full scan, legacy payload was accepted, and explicit full scanner dispatch did not reject. A second red run caught mixed legacy preparation fields and invalid full operations during active scans; both now return 400.

## WP1 temporary frontend compatibility boundary (closed by WP2)

WP2 owns the remaining legacy frontend modules and their shared declarations (`shared/opportunities.ts`, review/metrics helpers, and legacy types in `src/types.ts`). WP1 leaves these in place only for compile-time/frontend import closure. Folder reports still carry empty legacy arrays and zero counters until those consumers are removed. The production backend has no imports of the retired opportunity, review, ranking or full-file modules. WP2 closes these consumers and removes the compatibility payload fields, as recorded below.

WP1 verification: `npm run build` passed; `npm test` passed 142 tests with one pre-existing private qualification test skipped (143 total). Native fixture qualification verdicts remain Partial/Invalidated as designed; this change grants no new cleanup authority.

## WP2 — current-only interface

The application shell has stable Folders, Routines, History and Settings navigation. Workspace and report requests have separate explicit loading/failure states; no report is fabricated while either request is pending. Settings remain unavailable until their real values load. Report responses cannot change the active page, and request generations prevent obsolete responses replacing a newer selection. An unavailable report is attempted once automatically and can be retried explicitly; ordinary state polling does not create a report retry loop. Empty installations retain New scan, Settings and all fourteen routines without implicit scans, preset saves, preparation or execution.

| Removed artifact | Former consumers | Retained replacement |
| --- | --- | --- |
| `src/sample.ts` | Initial shell state, History demo entry, coverage fixture | Explicit loading/empty states; disposable folder fixture |
| `src/components/Development.tsx`, `OpportunityPlanner.tsx` | Standalone Development and planner | Existing fourteen Routines |
| `src/components/OpportunityTable.tsx`, `FindingDrawer.tsx` | Overview, Opportunities, Review queue and finding details | Folder tree, inspection, ignored-folder checks and separately confirmed cleanup |
| `src/Treemap.tsx` | Space map | Existing hierarchical folder tree |
| `shared/review.ts`, `shared/opportunities.ts` | Retired dispositions, planning and finding UI | Current routine contracts and the WP1 cleanup-change helper |
| Legacy `src/types.ts` declarations/helpers | Findings, reviews, development inventory, measurements, ranking, categories and duplicate groups | Folder report/settings/state and routine contracts |
| Empty `files`, `findings`, `duplicateGroups`, `opportunityBytes` report fields; `findingCount` summary | Temporary WP1 frontend compatibility | No compatibility payload fields in new reports |
| Retired CSS selectors | Deleted components and shell screens | Retained layout/dialog/routine/tree selectors; production CSS reduced from 61.20 kB to 33.16 kB |

No exclusive sample asset existed besides its source module. The application icon remains. Historical `findingId` metadata in the cleanup-audit type is not a preparation path or renderer; canonical audit records are preserved.

History lists folder summaries only, preserves same-coverage comparisons, and opens reports through the current report boundary. JSON/CSV downloads check HTTP success before creating a download; missing or unsupported exports surface a recoverable message. Settings retain exclusions, cloud policy and project roots. Removed scanner thresholds, duplicate settings and full-scan limits no longer appear.

### Browser and fixture replacement

- `startup-browser.mjs` adds eight cases: separately delayed state/report, navigation during report loading, empty inventory, failed state/report, missing report and unsupported format. A MutationObserver records startup navigation; checks cover focus, zero implicit POST requests, mobile overflow and serious/critical axe findings. The seven original cases failed against the baseline because explicit states/recoverable alerts were absent. The navigation race case guards the new shell's retained-page behavior.
- `browser.mjs` replaces sample/finding/map/disposition flows with current folder scanning, reveal acknowledgement and failure, JSON/CSV downloads, failed export recovery, exclusions and comparable History rows. Shared settings, history, keyboard and accessibility assertions remain.
- `cleanup-browser.mjs` moves development preparation to saved-directory preparation. Configured roots, cancellation, wrong/exact typed confirmation, real disposable deletion, audit persistence, snapshot warning and desktop/mobile axe checks remain.
- `routines-browser.mjs` replaces sample switching with empty-inventory removal/restoration. Navigation/report disposal, unknown sizes without a report, all fourteen decisions, sequential Run all, stop, independent expiry, server-ID preparation and disposable deletion remain.
- `folder-browser.mjs` removes legacy scan/History compatibility expectations and verifies retired settings are absent. Tree paging, inspection, cache/fresh scans, cleanup preview, snapshot invalidation and current History remain.
- `coverage-browser.mjs` uses a current folder fixture instead of importing production sample data; collapsed 1,000-entry coverage, keyboard, zero writes and axe assertions remain.
- Removed `opportunity-browser.mjs` and `review.test.mjs` cover only deleted planner/disposition features. `metrics.test.mjs` retains root parenting and conservative History comparison; its exclusive finding-category partition test is removed.
- Folder API/scanner tests now assert legacy report arrays are absent rather than empty.

Visual review uses the established navy rail, blue actions, Aptos/Segoe UI text and monospace paths. The folder hierarchy and routine decision table remain the main visual structures. Actual 1440×1050 and 390×844 loading, empty, folder-report and routine screenshots were opened and inspected; controls remain readable and contained. Screenshots and disposable-fixture logs are gitignored under `review/` and contain no live report data.

WP2 verification: production build passed; Node suite passed 138 tests with one existing skip (139 total); all seven scripts in `npm run test:ui` passed. No serious/critical axe findings, browser errors or horizontal overflow were found in the exercised views.

