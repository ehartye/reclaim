import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  RefreshCw,
  ShieldCheck,
  Copy,
  FolderGit2,
} from "lucide-react";
import type {
  RoutineCatalog,
  RoutineDefinition,
  RoutinePreset,
  RoutineRun,
  RoutineGuide,
} from "../types";
import { folderBytes } from "../folder-format";
import {
  RoutineBatch,
  isPreparationFresh,
  routineBatchProgress,
  sortedRoutineRows,
  type RoutineBatchState,
} from "../../shared/routine-batch";
const modes = {
  "in-app": "In-app review",
  guided: "Guided maintenance",
  "review-only": "Review only",
};
const signature = (value: RoutinePreset) =>
  JSON.stringify([
    value.routineId,
    value.policyVersion,
    value.minimumBytes,
    value.minimumAgeDays,
    value.roots,
  ]);
const statusLabels = {
  queued: "Queued",
  running: "Checking…",
  successful: "Checked",
  partial: "Partial discovery",
  failed: "Failed",
  "needs-settings": "Needs settings",
  "not-run": "Not run",
};
const displayDate = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Date unavailable";
export function Routines({
  api,
  scanId,
  onPrepare,
}: {
  api: (route: string, body?: unknown) => Promise<any>;
  scanId?: string;
  onPrepare: (request: { runId: string; candidateId: string }) => void;
}) {
  const [snapshot, setSnapshot] =
    useState<RoutineBatchState<RoutineRun> | null>(null);
  const [selected, setSelected] = useState("generated-output");
  const [draft, setDraft] = useState<RoutinePreset | null>(null);
  const [rootText, setRootText] = useState("");
  const [now, setNow] = useState(Date.now);
  const [singleBusy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const batch = useRef<RoutineBatch<RoutineRun> | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    setSnapshot(null);
    setDraft(null);
    setBusy(false);
    setError("");
    setMessage("");
    apiRef
      .current("routines")
      .then((next: RoutineCatalog) => {
        if (live) {
          const model = new RoutineBatch<RoutineRun>({
            catalog: next,
            scanId,
            request: (request) => apiRef.current("routines/run", request),
            onChange: setSnapshot,
          });
          batch.current = model;
          setSnapshot(model.getState());
          const preset = next.presets[selectedRef.current];
          setDraft(preset);
          setRootText(preset.roots.join("\n"));
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      revision.current++;
      batch.current?.dispose();
      batch.current = null;
    };
  }, [scanId]);
  useEffect(() => {
    let timer: number | undefined;
    function update() {
      const current = Date.now();
      setNow(current);
      const deadlines =
        snapshot?.rows.flatMap((row) =>
          typeof row.preparationDeadline === "number" &&
          row.preparationDeadline > current
            ? [row.preparationDeadline]
            : [],
        ) ?? [];
      if (deadlines.length)
        timer = window.setTimeout(update, Math.min(...deadlines) - current + 1);
    }
    update();
    return () => window.clearTimeout(timer);
  }, [snapshot]);
  const catalog = snapshot?.catalog;
  const row = snapshot?.rows.find((item) => item.definition.id === selected);
  const run = row?.run;
  const expired = !!run && !!row && !isPreparationFresh(row, now);
  const batchActive =
    !!snapshot &&
    ["refreshing", "running", "stopping"].includes(snapshot.status);
  const busy = singleBusy || batchActive;
  const progress = snapshot ? routineBatchProgress(snapshot) : null;
  const running = snapshot?.rows.find((item) => item.status === "running");
  const definition = catalog?.definitions.find((item) => item.id === selected);
  const valid =
    !!draft &&
    Number.isSafeInteger(draft.minimumBytes) &&
    draft.minimumBytes >= 0 &&
    draft.minimumBytes <= 1024 ** 5 &&
    (draft.minimumAgeDays === null ||
      (Number.isSafeInteger(draft.minimumAgeDays) &&
        draft.minimumAgeDays >= 0 &&
        draft.minimumAgeDays <= 36500));
  const stale =
    !!run && (!draft || signature(run.parameters) !== signature(draft));
  const dirty =
    !!draft &&
    !!catalog &&
    (signature(draft) !== signature(catalog.presets[selected]) ||
      rootText !== catalog.presets[selected].roots.join("\n"));
  const invalidPreset = catalog?.invalidPresets[selected];
  function useSaved() {
    if (busy || !catalog) return;
    const preset = structuredClone(catalog.presets[selected]);
    setDraft(preset);
    setRootText(preset.roots.join("\n"));
    setMessage("");
    setError("");
  }
  async function startAll() {
    const model = batch.current;
    if (!model || busy || dirty) return;
    setError("");
    setMessage("");
    await model.start(async () => {
      const next: RoutineCatalog = await apiRef.current("routines");
      if (batch.current === model) {
        const preset = next.presets[selectedRef.current];
        setDraft(structuredClone(preset));
        setRootText(preset.roots.join("\n"));
      }
      return next;
    });
  }
  async function action(save: boolean) {
    const model = batch.current;
    if (!model || busy || !draft || !valid || (!save && invalidPreset)) return;
    const current = ++revision.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (save) {
        const next: RoutineCatalog = await api("routines/presets", draft);
        if (current === revision.current) {
          model.replaceCatalog(next);
          setDraft(next.presets[selected]);
          setRootText(next.presets[selected].roots.join("\n"));
          model.clearResult(selected);
          setMessage("Preset saved for the next run.");
        }
      } else {
        const next: RoutineRun = await api("routines/run", {
          routineId: selected,
          parameters: {
            minimumBytes: draft.minimumBytes,
            minimumAgeDays: draft.minimumAgeDays,
            roots: draft.roots,
            policyVersion: draft.policyVersion,
          },
          ...(scanId ? { scanId } : {}),
        });
        if (current === revision.current) {
          model.replaceResult(next);
          setDraft(next.parameters);
          setRootText(next.parameters.roots.join("\n"));
        }
      }
    } catch (e) {
      if (current === revision.current) {
        setError((e as Error).message);
        if (!save) model.failResult(selected, e);
      }
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  function choose(item: RoutineDefinition) {
    revision.current++;
    setSelected(item.id);
    selectedRef.current = item.id;
    const retained = snapshot?.rows.find(
      (row) => row.definition.id === item.id,
    )?.run;
    const preset = structuredClone(
      retained?.parameters ?? catalog!.presets[item.id],
    );
    setDraft(preset);
    setRootText(preset.roots.join("\n"));
    setError("");
    setMessage("");
  }
  function guideContent(guide: RoutineGuide) {
    return (
      <details className="routine-guide">
        <summary>
          <BookOpen size={15} /> Maintenance guidance ·{" "}
          {guide.qualified ? "scope qualified" : "documentation only"}
        </summary>
        <h3>{guide.title}</h3>
        <ol>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {guide.notices.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
        {guide.commands.map((command) => (
          <div className="routine-command" key={command.command}>
            <strong>
              {command.label}
              {command.mutates ? " · Changes cache data" : ""}
            </strong>
            <p>{command.effects}</p>
            <small>Exact scope: {command.scope}</small>
            <code>{command.command}</code>
            <button
              className="secondary small"
              onClick={() => {
                void navigator.clipboard
                  .writeText(command.command)
                  .then(() =>
                    setMessage(
                      "Command copied. Review its scope before running it yourself.",
                    ),
                  )
                  .catch(() =>
                    setError(
                      "Copy failed. Select the command text to copy it.",
                    ),
                  );
              }}
            >
              <Copy size={13} />
              Copy command
            </button>
          </div>
        ))}
        {guide.evidence.map((url) => (
          <a href={url} target="_blank" rel="noreferrer" key={url}>
            Owner documentation
          </a>
        ))}
      </details>
    );
  }
  return (
    <div className="routines-workspace">
      <section
        className="panel routine-batch-bar"
        aria-label="Run all routines"
      >
        <div className="routine-batch-intro">
          <div>
            <h2>Compare recorded potential</h2>
            <p>
              Check every routine with its saved settings. Review cleanup
              individually.
            </p>
          </div>
          <div className="routine-actions">
            <button
              className="primary small"
              disabled={!catalog || busy || dirty}
              onClick={() => void startAll()}
            >
              <RefreshCw size={15} className={batchActive ? "spin" : ""} /> Run
              all
            </button>
            {batchActive && (
              <button
                className="secondary small"
                disabled={snapshot?.status === "stopping"}
                onClick={() => batch.current?.stopAfterCurrent()}
              >
                {snapshot?.status === "stopping"
                  ? "Stopping after current routine…"
                  : "Stop after current routine"}
              </button>
            )}
          </div>
        </div>
        {dirty && (
          <div className="routine-dirty" role="status">
            <span>
              Unsaved changes. Save this preset or use saved settings before Run
              all.
            </span>
            <button
              className="secondary small"
              disabled={busy}
              onClick={useSaved}
            >
              Use saved settings
            </button>
          </div>
        )}
        {!scanId && (
          <p className="routine-batch-note">
            No real report selected. Size evidence is unknown; checks use
            bounded discovery.
          </p>
        )}
        <p className="routine-batch-note">
          Potential is recorded logical scope size, not promised free space.
          Routines can overlap; there is no combined total.
        </p>
        {snapshot?.refreshError && (
          <div className="alert error" role="alert">
            Catalog refresh failed: {snapshot.refreshError}. Previous dated
            results remain available.
          </div>
        )}
        {progress && (
          <div
            className="routine-batch-progress"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>
              {snapshot?.status === "refreshing"
                ? "Refreshing saved settings…"
                : snapshot?.status === "stopping"
                  ? "Waiting for the current check to finish"
                  : running
                    ? `Checking ${running.definition.label}`
                    : snapshot?.status === "settled"
                      ? "Routine checks settled"
                      : "Ready to check routines"}
            </strong>
            <span>
              {progress.processed} of {progress.total} processed ·{" "}
              {progress.checked} checked · {progress.failed} failed ·{" "}
              {progress.needsSettings} needs settings · {progress.remaining}{" "}
              remaining · {progress.notRun} not run
            </span>
          </div>
        )}
      </section>
      <div
        id="routine-comparison"
        tabIndex={-1}
        className="routine-directory panel"
        aria-label="Cleanup routines"
      >
        <div className="panel-heading">
          <div>
            <h2>Routine comparison</h2>
            <p>Known recorded sizes, largest first.</p>
            <a className="routine-mobile-jump" href="#routine-detail">
              View selected routine ↓
            </a>
          </div>
        </div>
        {sortedRoutineRows(snapshot?.rows ?? []).map((entry) => {
          const item = entry.definition,
            summary = entry.summary;
          return (
            <button
              key={item.id}
              data-routine-id={item.id}
              className={`routine-choice ${selected === item.id ? "selected" : ""}`}
              aria-pressed={selected === item.id}
              disabled={singleBusy}
              onClick={() => choose(item)}
            >
              <span className="routine-row-heading">
                <strong>{item.label}</strong>
                <span className={`routine-status ${entry.status}`}>
                  {statusLabels[entry.status]}
                </span>
              </span>
              <span className="routine-row-meta">
                <span className={`routine-mode ${item.mode}`}>
                  {modes[item.mode]}
                </span>
                <small>{item.recoveryCost} recovery cost</small>
              </span>
              <span className="routine-potential">
                {!summary
                  ? "Size unknown"
                  : summary.candidateCount === 0
                    ? "No matches under saved filters"
                    : summary.knownBytes === null
                      ? "Size unknown"
                      : `${summary.estimated ? "≈ " : ""}${folderBytes(summary.knownBytes)} recorded`}
              </span>
              {summary && (
                <>
                  <small>
                    {summary.candidateCount} matching folders ·{" "}
                    {summary.unknownSizeCount} unknown size
                    {summary.estimated ? " · Estimated" : ""}
                    {summary.incomplete ? " · Incomplete sizes" : ""}
                  </small>
                  <small>
                    {summary.coverage.complete
                      ? "Complete discovery"
                      : "Partial discovery"}{" "}
                    · {summary.coverage.checkedDirectories} /{" "}
                    {summary.coverage.candidateCount} checked
                  </small>
                  <small>Checked {displayDate(summary.checkedAt)}</small>
                  <small>
                    {summary.recordedAt.length
                      ? `Size dates: ${summary.recordedAt.map(displayDate).join("; ")}`
                      : "No recorded size date"}
                  </small>
                  {!isPreparationFresh(entry, now) && (
                    <small className="routine-expired">
                      Run again to review cleanup
                    </small>
                  )}
                </>
              )}
              {entry.error && (
                <small className="routine-row-error">{entry.error}</small>
              )}
            </button>
          );
        })}
        {!catalog && !error && (
          <p className="routine-padding" role="status">
            Loading routines…
          </p>
        )}
      </div>
      <section
        id="routine-detail"
        tabIndex={-1}
        className="panel routine-detail"
        aria-label="Selected routine"
      >
        <a
          className="routine-mobile-jump routine-back"
          href="#routine-comparison"
        >
          ↑ Back to comparison
        </a>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="alert" role="status">
            {message}
          </div>
        )}
        {row?.error && row.error !== error && (
          <div className="alert error" role="alert">
            {row.error}
          </div>
        )}
        {definition && draft && (
          <>
            <div className="panel-heading">
              <div>
                <span className={`routine-mode ${definition.mode}`}>
                  {modes[definition.mode]}
                </span>
                <h2>{definition.label}</h2>
                <p>{definition.description}</p>
              </div>
              <ShieldCheck size={25} />
            </div>
            <div className="routine-padding">
              <p>{definition.boundary}</p>
              <p className="routine-muted">
                {definition.recoveryCost} recovery cost · Source assets, tool
                availability and later rebuild/download time matter.
              </p>
              {definition.evidence.map((url) => (
                <a href={url} target="_blank" rel="noreferrer" key={url}>
                  Owner documentation
                </a>
              ))}
            </div>
            {invalidPreset && (
              <div className="alert error">
                <strong>
                  Saved preset needs correction: {invalidPreset.error}
                </strong>
                <p>
                  Retained saved values are shown below. The editable fields
                  start with replacement defaults. Review them and save a
                  corrected preset before running.
                </p>
                <pre aria-label="Retained saved routine parameters">
                  {JSON.stringify(invalidPreset.parameters, null, 2)}
                </pre>
              </div>
            )}
            <fieldset className="routine-controls" disabled={busy}>
              <legend>Saved review parameters</legend>
              <label>
                Folder total greater than
                <div className="folder-threshold">
                  <input
                    aria-label="Routine minimum size in MB"
                    type="number"
                    min="0"
                    max={1024 ** 5 / 1e6}
                    step="any"
                    value={
                      Number.isFinite(draft.minimumBytes)
                        ? draft.minimumBytes / 1e6
                        : ""
                    }
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minimumBytes: Math.round(e.target.valueAsNumber * 1e6),
                      })
                    }
                  />
                  <span>MB</span>
                </div>
              </label>
              {definition.supportsAgeHint && (
                <label>
                  Age hint
                  <select
                    aria-label="Routine age hint"
                    value={draft.minimumAgeDays === null ? "off" : "on"}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minimumAgeDays: e.target.value === "off" ? null : 30,
                      })
                    }
                  >
                    <option value="off">Off</option>
                    <option value="on">Show older metadata</option>
                  </select>
                </label>
              )}
              {definition.supportsAgeHint && draft.minimumAgeDays !== null && (
                <label>
                  Minimum age hint in days
                  <input
                    aria-label="Routine minimum age in days"
                    type="number"
                    min="0"
                    max="36500"
                    value={
                      Number.isFinite(draft.minimumAgeDays)
                        ? draft.minimumAgeDays
                        : ""
                    }
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minimumAgeDays: e.target.valueAsNumber,
                      })
                    }
                  />
                </label>
              )}
              {definition.scope === "project" && (
                <label className="routine-roots">
                  Project roots · one per line
                  <textarea
                    aria-label="Routine project roots"
                    rows={3}
                    value={rootText}
                    onChange={(e) => {
                      setRootText(e.target.value);
                      setDraft({
                        ...draft,
                        roots: e.target.value
                          .split(/\r?\n/)
                          .map((v) => v.trim())
                          .filter(Boolean),
                      });
                    }}
                  />
                </label>
              )}
              <div className="routine-actions">
                <button
                  className="secondary small"
                  disabled={!valid}
                  onClick={() => void action(true)}
                >
                  Save preset
                </button>
                <button
                  className="primary small"
                  disabled={!valid || !!invalidPreset}
                  onClick={() => void action(false)}
                >
                  <RefreshCw size={15} className={singleBusy ? "spin" : ""} />
                  {singleBusy ? "Checking…" : "Run routine check"}
                </button>
              </div>
            </fieldset>
            {!valid && (
              <div className="alert error">
                Enter a valid size and age before saving or running.
              </div>
            )}
            <p className="routine-padding routine-muted">
              500 MB = 500,000,000 bytes. Sizes are recorded logical entries,
              not promised free space. Age hints do not prove a folder is
              unused.
            </p>
            {stale && (
              <div className="alert" role="status">
                Parameters changed. Run the routine again before reviewing
                cleanup.
              </div>
            )}
            {expired && (
              <div className="alert" role="status">
                Run again to review cleanup. This result’s evidence expired or
                its check date is unavailable.
              </div>
            )}
            {run && (
              <div
                className="routine-results"
                aria-label="Routine results"
                aria-busy={busy}
              >
                <div className="folder-total-summary">
                  <strong>
                    {run.candidates.length}{" "}
                    {run.candidates.length === 1 ? "candidate" : "candidates"}
                  </strong>
                  <span>Checked {displayDate(run.checkedAt)}</span>
                </div>
                <p className="routine-padding routine-muted">
                  Cleanup review evidence expires after five minutes. Rerun if a
                  preview reports stale evidence.
                </p>
                {run.notices.map((notice) => (
                  <p className="routine-padding routine-muted" key={notice}>
                    {notice}
                  </p>
                ))}
                {!run.coverage.complete && (
                  <div className="alert">
                    Partial coverage · {run.coverage.checkedDirectories} of{" "}
                    {run.coverage.candidateCount} candidates checked. Other
                    opportunities may be missing.
                  </div>
                )}
                {run.coverage.errors.map((item) => (
                  <p className="routine-padding" key={item.path}>
                    {item.path}: {item.reason}
                  </p>
                ))}
                {run.candidates.map((candidate) => (
                  <article className="routine-candidate" key={candidate.id}>
                    <div className="routine-candidate-heading">
                      <FolderGit2 size={18} />
                      <strong>{candidate.label || "Folder to review"}</strong>
                      <span className={`routine-mode ${candidate.mode}`}>
                        {modes[candidate.mode]}
                      </span>
                    </div>
                    <code className="routine-path">{candidate.path}</code>
                    <div className="routine-candidate-size">
                      {!scanId || candidate.logicalBytes === null
                        ? "Size unknown"
                        : `${candidate.estimated ? "≈ " : ""}${folderBytes(candidate.logicalBytes)}`}
                      <small>
                        {scanId && candidate.recordedAt
                          ? `Recorded ${new Date(candidate.recordedAt).toLocaleString()}`
                          : "No recorded size date"}
                        {!candidate.complete ? " · Incomplete" : ""}
                      </small>
                    </div>
                    <p>{candidate.reason}</p>
                    {candidate.restore && (
                      <p className="routine-muted">
                        To use it again: {candidate.restore}
                      </p>
                    )}
                    {candidate.ageState && candidate.ageState !== "off" && (
                      <p className="routine-muted">
                        Age evidence: {candidate.ageState.replaceAll("-", " ")}
                      </p>
                    )}
                    {candidate.cleanupSupported &&
                      candidate.mode === "in-app" && (
                        <button
                          className="secondary small"
                          disabled={busy || stale || expired || !!error}
                          onClick={() => {
                            if (
                              !row ||
                              busy ||
                              stale ||
                              !isPreparationFresh(row)
                            )
                              return;
                            onPrepare({
                              runId: run.id,
                              candidateId: candidate.id,
                            });
                          }}
                        >
                          Review cleanup
                        </button>
                      )}
                    {candidate.guide && guideContent(candidate.guide)}
                  </article>
                ))}
                {!run.candidates.length && (
                  <div className="empty">
                    <FolderGit2 size={30} />
                    <h3>No candidates match this review</h3>
                    <p>
                      Lower the threshold, check the project roots or choose a
                      fresh scan. Unknown cache roles stay review-only.
                    </p>
                  </div>
                )}
              </div>
            )}
            {!run && (
              <div className="routine-padding routine-empty">
                <BookOpen size={24} />
                <p>
                  Run this routine to review matching folders and available
                  guidance. No cleanup runs during discovery.
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
