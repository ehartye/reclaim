# Offline result purge

This Windows maintenance command permanently unlinks existing saved scan results. It makes no report archive, backup, quarantine or Recycle Bin copy. It does not claim secure media erasure. Future folder scans continue to save normally. Do not run apply until the delivery review has passed and an operator has established exclusive maintenance.

## Inventory

```powershell
node scripts/purge-scan-results.mjs --data-dir C:\absolute\data --receipt C:\absolute\evidence\purge-receipt.json
```

Both paths must be absolute local drive paths. The data directory and receipt parent must already exist without reparse ancestors. The receipt must be outside the data directory and must not exist. Inventory reads only file metadata and bounded `state.json` content, and writes only the requested metadata receipt. It never opens report payloads. Report files may be large; state and receipt reads are limited to 16 MiB.

The receipt records tool/version, build commit, original target identities and sizes, exact data/receipt paths, preserved-field hashes, unknown entries, process evidence and status. Windows CurrentUser DPAPI seals the inventory digest, receipt identity and owner. Run inventory and apply as the same Windows user. Copying/replacing the receipt or changing the sealed inventory makes it invalid; generate a new inventory under a new receipt name instead. A receipt contains no saved report bodies, review selections or copied settings/presets/audit entries.

## Exact deletion scope

- Root UUID `.json` report files, including reports absent from state.
- `intelligence/UUID.json` indexes, `intelligence/folders-<64 hex>.json` Quick caches and `intelligence/measurements.json`.
- `activation-before.json` and `ignored-folder-review.json` diagnostic snapshots.
- Producer-verified temporary files: root `state.tmp` (`server/app.mjs` state writer), `intelligence/UUID.UUID.tmp` (retired index writer), `intelligence/measurements.json.tmp` (retired measurement writer), and `intelligence/folders-<64 hex>.json.UUID.tmp` (folder cache writer). Historical producers can be inspected at baseline `8882623`.
- State scan summaries and reviews. The nine retired settings documented in `legacy-removal-inventory.md` are removed; supported settings retain their exact canonical values. Unknown settings and other unrelated top-level fields are preserved rather than guessed obsolete.

The tool preserves canonical cleanup audit history, all routine preset values including invalid entries needing repair, current preferences, logs and unrelated files. Unknown entries are disclosed in the receipt and remain untouched. Unknown directories are not traversed. Recognized targets that are links, reparse points, directories or hardlinked files cause refusal. No recursive directory removal, permission changes or forced unlink is used.

## Exclusive maintenance and process evidence

Before apply, identify every candidate service, its executable, PID/creation time, working checkout and actual data-directory configuration, including `RECLAIM_DATA_DIR`. Check all ports and workers. Obtain an idle API response (no scan, cleanup, measurement or routine operation), gracefully shut down through the authenticated shutdown API, then observe service and worker exit. Retained routine operations use the service cleanup-busy gate; record that verified interpretation when deriving `routineBusy: false`. Do not write session tokens to evidence. Neither a shutdown response nor an idle response proves all writers have exited.

An operator must control launchers and prohibit restart until apply finishes. Fill only `serviceExitEvidence` in the existing receipt, using an in-place write that preserves its file identity; do not replace the receipt using an editor's atomic-save mode. This operator record is not an automated proof of the historical launch configuration. The maintenance owner must actually inspect and verify those fields; guessed values or file timestamps are insufficient. The CLI validates the evidence structure and chronology, then performs fresh native process enumeration immediately before mutation. It refuses remaining recorded process IDs, recognized Reclaim candidates and opaque/ambiguous Node processes. Enumeration failure refuses apply; there is no CLI bypass or test adapter option.

Example schema (replace every placeholder with observed metadata; this is not usable evidence):

```json
{
  "operatorControlsLaunchers": true,
  "restartProhibitedUntilComplete": true,
  "recordedAt": "<ISO timestamp>",
  "services": [
    {
      "pid": 123,
      "createdAt": "<ISO timestamp>",
      "executablePath": "C:\\absolute\\node.exe",
      "commandLine": "<observed command line>",
      "checkout": "C:\\absolute\\checkout",
      "dataDir": "C:\\absolute\\data",
      "launchEvidence": {
        "source": "verified-process-inspection",
        "observedAt": "<ISO timestamp>",
        "cwd": "C:\\absolute\\checkout",
        "RECLAIM_DATA_DIR": "C:\\absolute\\data"
      },
      "idle": {
        "product": "reclaim",
        "job": null,
        "cleanupBusy": false,
        "measurementJob": null,
        "routineBusy": false,
        "observedAt": "<ISO timestamp>"
      },
      "shutdown": {
        "authenticated": true,
        "status": 200,
        "at": "<ISO timestamp>"
      },
      "exit": { "observed": true, "observedAt": "<ISO timestamp>" },
      "workers": [
        {
          "pid": 124,
          "createdAt": "<ISO timestamp>",
          "exited": true,
          "observedAt": "<ISO timestamp>"
        }
      ]
    }
  ]
}
```

Use `null` for an observed absent environment override, and an empty workers array only after verifying there were no child processes. All listed services must map to the target data directory. Other observed Reclaim services conservatively block this command until their ownership is resolved. The process check is a point-in-time observation, not a race-proof single-writer lock. If launch ownership or exclusive maintenance cannot be assured, stop and defer live purge; do not weaken these checks.

## Apply and resume

```powershell
node scripts/purge-scan-results.mjs --data-dir C:\absolute\data --receipt C:\absolute\evidence\purge-receipt.json --apply --exclusive-maintenance
```

Apply validates receipt ownership, state syntax, retained values, directory identity and the exact inventory. New or changed targets require a fresh inventory. Missing targets are recorded without reconstructing them. State is atomically replaced with sanitized content before any result file is unlinked. The small temporary state file contains only sanitized values; no full-state backup is made.

On failure, keep the service stopped. A `partial` receipt identifies completed/pending targets and errors. Resume with the identical command and receipt after resolving the failure. Resume accepts either original state or the exact sanitized state, so an interrupted receipt update cannot restore deleted results or summaries. A matching sanitized temporary file can be removed on resume; an unexpected file at that path is preserved and causes a partial result. A repeated complete apply is idempotent. Receipt-write failure is an error, never reported as successful completion; retain the previous receipt and retry.

After complete deletion, activate the reviewed build through the standard launcher. Verify served artifact identity, empty inventory, unavailable old report IDs/preparation tokens, no derived results and equal retained-field hashes. Use state/discovery only; do not start a new filesystem scan as a delivery check. Keep metadata receipts and non-report verification evidence. Unknown entries in the receipt mean the command does not claim the entire data directory is empty.

## Fixture verification

`node --test tests/purge-scan-results.test.mjs` uses temporary disposable directories and an imported process adapter. The CLI never accepts injected adapters or I/O controls. Fixtures cover exact allowlisting, retained values, invalid presets, malformed state, collisions, forged/copied receipts, hardlinks/junctions, changed/added targets, second writers/ambiguity, missing targets, write/delete interruption and idempotent resume. The first seven tests failed before implementation; retired-setting removal also had a separately observed failing preservation assertion before the sanitizer was updated.
