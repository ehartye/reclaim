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

## Temporary frontend compatibility boundary

WP2 owns the remaining legacy frontend modules and their shared declarations (`shared/opportunities.ts`, review/metrics helpers, and legacy types in `src/types.ts`). WP1 leaves these in place only for compile-time/frontend import closure. Folder reports still carry empty legacy arrays and zero counters until those consumers are removed. The production backend has no imports of the retired opportunity, review, ranking or full-file modules. WP2 must close and remove these remaining consumers, assets and browser workflows before delivery.

WP1 verification: `npm run build` passed; `npm test` passed 142 tests with one pre-existing private qualification test skipped (143 total). Native fixture qualification verdicts remain Partial/Invalidated as designed; this change grants no new cleanup authority.
