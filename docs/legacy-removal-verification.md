# Current-only interface and offline purge verification

## Reviewed implementation

The retained product consists of Folders, fourteen Routines, Settings and folder-only History/JSON/CSV exports. Retired screens, sample initialization, full-file analysis and exclusive APIs are removed. The [dependency inventory](legacy-removal-inventory.md) identifies former consumers, shared-helper extractions and migrated safety coverage.

Packages ran sequentially with test-first implementation and independent reviews:

| Package | Reviewed commit | Outcome |
| --- | --- | --- |
| Retained backend | `769aab7` | PASS; 30 independently executed focused tests |
| Current-only UI | `952ab59` | PASS after a failing browser regression and correction for Stop scan using GET instead of authenticated POST |
| Offline purge | `9f6c803` | PASS; all 17 purge fixture groups independently executed |

The first purge review identified an unrecognized wrapper-hosted writer, state fragments in raw parser diagnostics and incomplete preference validation. Each finding received a failing regression before correction. Fresh review confirmed conservative process classification, bounded diagnostics and shared application validation.

## Final integration gate

The final implementation tree at `9f6c803` passed:

- `npm run build` — TypeScript and Vite production output.
- `npm test` — 156 passed, zero failed, one existing private qualification skip (157 total).
- `npm run test:ui` — all seven scripts: startup, current-folder workflow, cleanup, folder tree, ignored folders, routines and coverage.

Startup tests delay state and report requests separately, observe navigation mutations, exercise empty/failed/missing/unsupported states and navigation during delayed reports, and assert zero implicit mutation requests. Retained browser coverage includes JSON/CSV downloads and recoverable export errors, exclusions, history comparisons, folder paging/inspection/cache, routine preset/batch/stop/disposal behavior, independent seven-minute expiry, server-ID preparation and disposable typed-confirmation deletion.

Authors and independent reviewers inspected loading, empty Folders, folder-report and Routines screenshots at 1440×1050 and 390×844. Automated checks reported no horizontal overflow or serious/critical axe findings; focus remains stable through asynchronous startup and recovery. Folder-opening tests validate or intercept requests rather than launching desktop applications.

The purge fixtures cover exact recognized and orphan targets, metadata-only inventory, supported preference and invalid-preset preservation, unrelated files, malformed state, receipt collisions/tampering/copies, hardlinks/reparse paths, changed targets/state, second/unknown writers, observation failure, missing files, write/delete interruption and idempotent resume. All deletion tests use disposable fixtures.

## Delivery and live maintenance status

This verification proves the implementation and disposable fixtures. It does not claim a live purge, service activation, native cleanup qualification, single-writer ownership or resolution of authentication/protected-path follow-ups.

A metadata-only inventory may be prepared while the service remains untouched. Applying it requires the [offline maintenance contract](offline-result-purge.md): verified service launch/data-directory ownership, idle state, graceful shutdown, observed service/worker exit and operator control preventing restart. Other Node/Electron runtimes are conservatively treated as candidate or ambiguous writers. Point-in-time enumeration is not a race-proof lock; unresolved ownership means defer apply.

Before release, a fresh delivery review must inspect these gates and the exact local metadata receipt. After authorized squash delivery, sync main and retain only non-report verification evidence before removing the feature worktree. Live activation and post-purge API/hash checks remain separate gates and must be reported as pending if exclusive maintenance cannot be established. No report archive or backup is part of delivery.
