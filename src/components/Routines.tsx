import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Copy, RefreshCw } from "lucide-react";
import type {
  RoutineCatalog,
  RoutineDefinition,
  RoutinePreset,
  RoutineRun,
  RoutineGuide,
} from "../types";
import { folderBytes } from "../folder-format";
import {
  presentRoutine,
  presentRoutineCandidate,
  type RoutineActionKind,
} from "../routine-presentation";
import {
  RoutineBatch,
  isPreparationFresh,
  routineBatchProgress,
  sortedRoutineRows,
  type RoutineBatchRow,
  type RoutineBatchState,
} from "../../shared/routine-batch";

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
type Section = "settings" | "guidance" | "folders";

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
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<RoutinePreset | null>(null);
  const [rootText, setRootText] = useState("");
  const [now, setNow] = useState(Date.now);
  const [singleBusy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false),
    [evidenceOpen, setEvidenceOpen] = useState(false),
    [guidanceOpen, setGuidanceOpen] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const batch = useRef<RoutineBatch<RoutineRun> | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const revision = useRef(0);
  const scrollTarget = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(null);
    setSelected("");
    selectedRef.current = "";
    setDraft(null);
    setBusy(false);
    setError("");
    setMessage("");
    apiRef
      .current("routines")
      .then((next: RoutineCatalog) => {
        if (!live) return;
        const model = new RoutineBatch<RoutineRun>({
          catalog: next,
          scanId,
          request: (request) => apiRef.current("routines/run", request),
          onChange: setSnapshot,
        });
        batch.current = model;
        setSnapshot(model.getState());
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
  // Only owner selection/action sets this ref. Progress, sorting and expiry
  // rerender without moving focus or scrolling the page.
  useLayoutEffect(() => {
    if (!scrollTarget.current) return;
    document
      .getElementById(scrollTarget.current)
      ?.scrollIntoView({ block: "start" });
    scrollTarget.current = null;
  }, [selectionRevision]);
  const catalog = snapshot?.catalog;
  const row = snapshot?.rows.find((item) => item.definition.id === selected);
  const run = row?.run,
    definition = row?.definition;
  const batchActive =
    !!snapshot &&
    ["refreshing", "running", "stopping"].includes(snapshot.status);
  const busy = singleBusy || batchActive;
  const progress = snapshot ? routineBatchProgress(snapshot) : null;
  const running = snapshot?.rows.find((item) => item.status === "running");
  const valid =
    !!draft &&
    Number.isSafeInteger(draft.minimumBytes) &&
    draft.minimumBytes >= 0 &&
    draft.minimumBytes <= 1024 ** 5 &&
    (draft.minimumAgeDays === null ||
      (Number.isSafeInteger(draft.minimumAgeDays) &&
        draft.minimumAgeDays >= 0 &&
        draft.minimumAgeDays <= 36500));
  const dirty =
    !!draft &&
    !!catalog &&
    (signature(draft) !== signature(catalog.presets[selected]) ||
      rootText !== catalog.presets[selected].roots.join("\n"));
  const stale =
    !!run && (!draft || signature(run.parameters) !== signature(draft));
  const invalidPreset = catalog?.invalidPresets[selected];
  const presentation = row
    ? presentRoutine(row, {
        invalidPreset,
        draftValid: valid,
        dirty,
        evidenceChanged: stale,
        busy,
        now,
      })
    : null;

  function useSaved() {
    if (busy || !catalog || !selected) return;
    const preset = structuredClone(catalog.presets[selected]);
    setDraft(preset);
    setRootText(preset.roots.join("\n"));
    setMessage("");
    setError("");
  }
  function moveTo(id: string) {
    scrollTarget.current = id;
    setSelectionRevision((value) => value + 1);
  }
  function choose(item: RoutineDefinition, section?: Section, toggle = false) {
    if (!catalog) return false;
    if (dirty && (item.id !== selected || toggle)) {
      setMessage("");
      moveTo("routine-detail");
      return false;
    }
    if (item.id === selected && toggle) {
      setSelected("");
      selectedRef.current = "";
      setDraft(null);
      setError("");
      setMessage("");
      return true;
    }
    if (item.id !== selected) {
      const preset = structuredClone(catalog.presets[item.id]);
      setSelected(item.id);
      selectedRef.current = item.id;
      setDraft(preset);
      setRootText(preset.roots.join("\n"));
      setSettingsOpen(section === "settings");
      setEvidenceOpen(false);
      setGuidanceOpen(section === "guidance");
      setError("");
      setMessage("");
    } else {
      if (section === "settings") setSettingsOpen(true);
      if (section === "guidance") setGuidanceOpen(true);
    }
    moveTo(
      section === "guidance"
        ? "routine-guidance"
        : section === "settings"
          ? "routine-settings"
          : section === "folders"
            ? "routine-folders"
            : "routine-detail",
    );
    return true;
  }
  async function startAll() {
    const model = batch.current;
    if (!model || busy || dirty) return;
    setError("");
    setMessage("");
    await model.start(async () => {
      const next: RoutineCatalog = await apiRef.current("routines");
      if (batch.current === model && selectedRef.current) {
        const preset = next.presets[selectedRef.current];
        setDraft(structuredClone(preset));
        setRootText(preset.roots.join("\n"));
      }
      return next;
    });
  }
  async function check(id: string, parameters: RoutinePreset) {
    const model = batch.current;
    if (!model || busy || catalog?.invalidPresets[id]) return;
    const current = revision.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next: RoutineRun = await apiRef.current("routines/run", {
        routineId: id,
        parameters: {
          minimumBytes: parameters.minimumBytes,
          minimumAgeDays: parameters.minimumAgeDays,
          roots: parameters.roots,
          policyVersion: parameters.policyVersion,
        },
        ...(scanId ? { scanId } : {}),
      });
      if (current !== revision.current || batch.current !== model) return;
      model.replaceResult(next);
      if (selectedRef.current === id) {
        setDraft(next.parameters);
        setRootText(next.parameters.roots.join("\n"));
      }
    } catch (e) {
      if (current === revision.current && batch.current === model) {
        model.failResult(id, e);
        if (selectedRef.current === id) setError((e as Error).message);
      }
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  async function save() {
    const model = batch.current;
    if (!model || busy || !draft || !valid) return;
    const id = selected,
      current = revision.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next: RoutineCatalog = await apiRef.current(
        "routines/presets",
        draft,
      );
      if (current !== revision.current || batch.current !== model) return;
      model.replaceCatalog(next);
      model.clearResult(id);
      if (selectedRef.current === id) {
        setDraft(next.presets[id]);
        setRootText(next.presets[id].roots.join("\n"));
        setMessage("Preset saved for the next run.");
      }
    } catch (e) {
      if (current === revision.current && selectedRef.current === id)
        setError((e as Error).message);
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  function compactAction(
    entry: RoutineBatchRow<RoutineRun>,
    kind: RoutineActionKind,
  ) {
    const checking = ["check", "retry", "check-again"].includes(kind);
    if (checking && (busy || dirty)) return;
    const section =
      kind === "fix-settings" || kind === "review-filters"
        ? "settings"
        : kind === "view-guidance" || kind === "read-guidance"
          ? "guidance"
          : undefined;
    // Compact checks always use saved parameters, never the expanded draft.
    if (!choose(entry.definition, section)) return;
    if (kind === "review-folders") moveTo("routine-folders");
    if (checking)
      void check(
        entry.definition.id,
        structuredClone(catalog!.presets[entry.definition.id]),
      );
  }
  function guideContent(guide: RoutineGuide, path: string) {
    return (
      <section className="routine-guide" key={path}>
        <h4>{guide.title}</h4>
        <p>
          <strong>
            {guide.qualified && guide.mode === "guided"
              ? "Scope qualified"
              : "Documentation only"}
          </strong>{" "}
          · <code>{path}</code>
        </p>
        <ol>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {[...new Set(guide.notices)].map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
        {guide.qualified &&
          guide.mode === "guided" &&
          guide.commands.map((command) => (
            <div className="routine-command" key={command.command}>
              <strong>
                {command.label}
                {command.mutates ? " · Changes cache data" : ""}
              </strong>
              <p>{command.effects}</p>
              <p>
                Exact scope: <code>{command.scope}</code>
              </p>
              <p>
                {command.optional ? "Optional. " : ""}Copying does not run this
                command. Review it before running it yourself.
              </p>
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
                <Copy size={14} /> Copy command
              </button>
            </div>
          ))}
        {guide.evidence.map((url) => (
          <a href={url} target="_blank" rel="noreferrer" key={url}>
            Owner documentation · {new URL(url).hostname}
          </a>
        ))}
      </section>
    );
  }
  const details =
    definition && draft && row && presentation ? (
      <section
        id="routine-detail"
        className="routine-detail"
        aria-label="Selected routine"
        tabIndex={-1}
      >
        <h2>{definition.label}</h2>
        <div className="routine-decision" aria-label="Routine decision">
          <div>
            <h3>What it is</h3>
            <p>{presentation.explanation}</p>
          </div>
          <div>
            <h3>What you can do</h3>
            <button
              className={
                presentation.action.kind === "review-folders"
                  ? "primary small"
                  : "secondary small"
              }
              disabled={presentation.action.disabled}
              onClick={() => compactAction(row, presentation.action.kind)}
            >
              {presentation.action.label}
            </button>
            {presentation.action.reason &&
              !error &&
              !row.error &&
              !invalidPreset &&
              valid &&
              !dirty &&
              !stale &&
              (!run || presentation.fresh) &&
              !busy &&
              presentation.action.kind !== "review-filters" && (
                <p className="routine-action-reason">
                  {presentation.action.reason}
                </p>
              )}
          </div>
          <div>
            <h3>Risk</h3>
            <p>{presentation.risk}</p>
          </div>
        </div>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {row.error && row.error !== error && (
          <div className="alert error" role="alert">
            {row.error}
          </div>
        )}
        {message && (
          <div className="alert" role="status">
            {message}
          </div>
        )}
        {dirty && (
          <div className="routine-dirty" role="status">
            <span>
              Unsaved changes. Save preset or use saved settings before
              switching routines or starting a saved-setting check. Then repeat
              your action.
            </span>
            <button
              className="secondary small"
              disabled={busy || !valid}
              onClick={() => void save()}
            >
              Save preset
            </button>
            <button
              className="secondary small"
              disabled={busy}
              onClick={useSaved}
            >
              Use saved settings
            </button>
          </div>
        )}
        {invalidPreset && (
          <p className="routine-warning">
            Saved preset needs correction: {invalidPreset.error}. Open Review
            settings to correct and save it.
          </p>
        )}
        {!valid && (
          <p className="routine-warning">
            Enter a valid size and age before saving or running.
          </p>
        )}
        {stale && (
          <p className="routine-warning">
            Parameters changed. Check again before reviewing cleanup.
          </p>
        )}
        {run && !presentation.fresh && (
          <p className="routine-warning">
            Run again to review cleanup. This result’s evidence expired or its
            check date is unavailable.
          </p>
        )}
        {busy && (
          <p className="routine-warning">
            A routine check or preset save is in progress. Browsing remains
            available; checks, saving and cleanup preparation are disabled.
          </p>
        )}
        {run && !run.coverage.complete && (
          <p className="routine-warning">
            Partial coverage · {run.coverage.checkedDirectories} of{" "}
            {run.coverage.candidateCount} candidates checked. Other
            opportunities may be missing.
          </p>
        )}
        <div
          id="routine-folders"
          className="routine-results"
          aria-label="Routine results"
          aria-busy={busy}
        >
          <div className="routine-folders-heading">
            <h3>Matching folders</h3>
            {run && (
              <p>
                {presentation.counts.eligibleForReview} eligible for review ·{" "}
                {presentation.counts.reviewOnly} review only
                {presentation.counts.qualifiedGuidance
                  ? ` · ${presentation.counts.qualifiedGuidance} guided`
                  : ""}
              </p>
            )}
          </div>
          {!run && (
            <p>
              Check this routine to find matching folders. Cleanup is reviewed
              separately.
            </p>
          )}
          {run?.candidates.length === 0 && (
            <p>
              No matches under saved filters. Review the size threshold and
              roots in Review settings.
            </p>
          )}
          {run?.candidates.map((candidate) => {
            const candidateView = presentRoutineCandidate(
              definition,
              candidate,
            );
            return (
              <article className="routine-candidate" key={candidate.id}>
                <div className="routine-candidate-heading">
                  <strong>{candidate.label || "Folder to review"}</strong>
                  <span
                    className={`routine-mode ${candidateView.reviewOnly ? "review-only" : candidate.mode}`}
                  >
                    {candidateView.eligibleForReview
                      ? "In-app review"
                      : candidateView.qualifiedGuidance
                        ? "Guided maintenance"
                        : "Review only"}
                  </span>
                </div>
                <code className="routine-path">{candidate.path}</code>
                <div className="routine-candidate-size">
                  {!scanId || candidate.logicalBytes === null
                    ? "Size unknown"
                    : `${candidate.estimated ? "≈ " : ""}${folderBytes(candidate.logicalBytes)}`}
                  <small>
                    {candidate.estimated ? "Estimated · " : ""}
                    {!candidate.complete ? "Incomplete · " : ""}
                    {scanId && candidate.recordedAt
                      ? `Recorded ${displayDate(candidate.recordedAt)}`
                      : "No recorded size date"}
                  </small>
                </div>
                <p>{candidate.blockedReason || candidate.reason}</p>
                {candidate.blockedReason &&
                  candidate.reason !== candidate.blockedReason && (
                    <p>{candidate.reason}</p>
                  )}
                {candidate.restore && (
                  <p>To use it again: {candidate.restore}</p>
                )}
                {candidateView.eligibleForReview && (
                  <button
                    className="secondary small"
                    disabled={!presentation.canPrepare || !!error}
                    onClick={() => {
                      if (
                        !presentation.canPrepare ||
                        busy ||
                        dirty ||
                        stale ||
                        candidate.blockedReason ||
                        !isPreparationFresh(row)
                      )
                        return;
                      onPrepare({ runId: run.id, candidateId: candidate.id });
                    }}
                  >
                    Review cleanup
                  </button>
                )}
                {candidate.guide && (
                  <button
                    className="secondary small"
                    onClick={() => {
                      setGuidanceOpen(true);
                      moveTo("routine-guidance");
                    }}
                  >
                    {candidateView.qualifiedGuidance
                      ? "View guidance"
                      : "Read guidance"}
                  </button>
                )}
              </article>
            );
          })}
        </div>
        <div className="routine-disclosures">
          <details
            id="routine-settings"
            open={settingsOpen}
            onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
          >
            <summary>Review settings</summary>
            {invalidPreset && (
              <div className="alert error">
                <p>
                  Retained saved values are shown here. Editable fields start
                  with replacement defaults. Review them and save a corrected
                  preset before running.
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
                {!dirty && (
                  <button
                    className="secondary small"
                    disabled={!valid}
                    onClick={() => void save()}
                  >
                    Save preset
                  </button>
                )}
                <button
                  className="primary small"
                  disabled={!presentation.canCheckDraft}
                  onClick={() => void check(selected, draft)}
                >
                  <RefreshCw size={15} className={singleBusy ? "spin" : ""} />
                  {singleBusy ? "Checking…" : "Run routine check"}
                </button>
              </div>
            </fieldset>
            <p>
              500 MB = 500,000,000 bytes. The threshold is strict. Age hints do
              not prove a folder is unused.
            </p>
          </details>
          <details
            id="routine-evidence"
            open={evidenceOpen}
            onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}
          >
            <summary>Evidence and coverage</summary>
            <p>{definition.description}</p>
            <p>{definition.boundary}</p>
            <p>
              {definition.recoveryCost} recovery cost describes rebuild or
              download expense, not cleanup safety.
            </p>
            <p>
              Recorded sizes are logical entries, not promised free space.
              Routines can overlap; there is no combined total. Cleanup-review
              evidence expires after five minutes; selecting a result does not
              renew it.
            </p>
            {run && (
              <>
                <p>
                  Checked{" "}
                  <time dateTime={run.checkedAt}>
                    {displayDate(run.checkedAt)}
                  </time>{" "}
                  ·{" "}
                  {row.preparationDeadline
                    ? `Original review deadline: ${displayDate(new Date(row.preparationDeadline).toISOString())}`
                    : "Review deadline unavailable"}
                </p>
                <p>
                  {run.coverage.complete
                    ? "Complete discovery"
                    : "Partial discovery"}{" "}
                  · {run.coverage.checkedDirectories} /{" "}
                  {run.coverage.candidateCount} checked. Routine inspection does
                  not make the source report complete or current.
                </p>
                <p>
                  {row.summary?.candidateCount} matching folders ·{" "}
                  {row.summary?.unknownSizeCount} unknown size.{" "}
                  {row.summary?.recordedAt.length
                    ? `Size dates: ${row.summary.recordedAt.map(displayDate).join("; ")}`
                    : "No recorded size date"}
                </p>
                {[...new Set(run.notices)].map((notice) => (
                  <p key={notice}>{notice}</p>
                ))}
                {run.coverage.errors.map((item) => (
                  <p key={item.path}>
                    <code>{item.path}</code>: {item.reason}
                  </p>
                ))}
                {run.candidates.map((candidate) => (
                  <div
                    className="routine-candidate-evidence"
                    key={candidate.id}
                  >
                    <code>{candidate.path}</code>
                    <p>
                      {scanId && candidate.logicalBytes !== null
                        ? `${candidate.logicalBytes.toLocaleString()} exact recorded bytes`
                        : "Size unknown"}{" "}
                      ·{" "}
                      {scanId && candidate.recordedAt
                        ? `Source date: ${candidate.recordedAt}`
                        : "No recorded size date"}
                      {candidate.estimated ? " · Estimated" : ""}
                      {!candidate.complete ? " · Incomplete" : ""}
                    </p>
                    {candidate.ageState && candidate.ageState !== "off" && (
                      <p>
                        Age evidence: {candidate.ageState.replaceAll("-", " ")}
                      </p>
                    )}
                  </div>
                ))}
              </>
            )}
          </details>
          <details
            id="routine-guidance"
            open={guidanceOpen}
            onToggle={(event) => setGuidanceOpen(event.currentTarget.open)}
          >
            <summary>Guidance and sources</summary>
            {run?.candidates
              .filter((candidate) => candidate.guide)
              .map((candidate) =>
                guideContent(candidate.guide!, candidate.path),
              )}
            {definition.evidence.map((url) => (
              <a href={url} target="_blank" rel="noreferrer" key={url}>
                Owner documentation · {new URL(url).hostname}
              </a>
            ))}
            {!run?.candidates.some((candidate) => candidate.guide) &&
              !definition.evidence.length && (
                <p>
                  No owner guidance is available for this routine. Inspect its
                  evidence and restrictions.
                </p>
              )}
          </details>
        </div>
      </section>
    ) : null;

  return (
    <div className="routines-workspace">
      <section
        className="panel routine-batch-bar"
        aria-label="Run all routines"
      >
        <div className="routine-batch-intro">
          <div>
            <p>Checks only. Cleanup is reviewed separately.</p>
          </div>
          <div className="routine-actions">
            <button
              className="primary small"
              disabled={!catalog || busy || dirty}
              onClick={() => void startAll()}
            >
              <RefreshCw size={15} className={batchActive ? "spin" : ""} />
              Run all
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
        {!scanId && (
          <p className="routine-batch-note">
            No real report selected. Size evidence is unknown; checks use
            bounded discovery.
          </p>
        )}
        {snapshot?.refreshError && (
          <div className="alert error" role="alert">
            Catalog refresh failed: {snapshot.refreshError}. Previous dated
            results remain available.
          </div>
        )}
        {!selected && error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {progress && (
          <>
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
                {progress.processed} of {progress.total} processed
                {progress.failed ? ` · ${progress.failed} failed` : ""}
                {progress.needsSettings
                  ? ` · ${progress.needsSettings} needs settings`
                  : ""}
                {progress.notRun ? ` · ${progress.notRun} not run` : ""}
              </span>
            </div>
            <details className="routine-batch-details">
              <summary>Batch details</summary>
              <p>
                {progress.checked} checked · {progress.failed} failed ·{" "}
                {progress.needsSettings} needs settings · {progress.remaining}{" "}
                remaining · {progress.notRun} not run
              </p>
              <p>
                Run all uses each routine’s saved settings, one check at a time.
                Stop waits for the current check; leaving this workspace ends
                the queue.
              </p>
            </details>
          </>
        )}
      </section>
      <div
        id="routine-comparison"
        className="routine-directory panel"
        aria-label="Cleanup routines"
      >
        <table className="routine-comparison">
          <caption>
            Known recorded sizes, largest first. Select a routine to inspect its
            folders.
          </caption>
          <colgroup>
            <col className="routine-name-col" />
            <col className="routine-size-col" />
            <col className="routine-action-col" />
            <col className="routine-risk-col" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Routine</th>
              <th scope="col">Recorded size</th>
              <th scope="col">What you can do</th>
              <th scope="col">Risk</th>
            </tr>
          </thead>
          <tbody>
            {sortedRoutineRows(snapshot?.rows ?? []).map((entry) => {
              const item = entry.definition,
                summary = entry.summary;
              const view = presentRoutine(entry, {
                invalidPreset: catalog?.invalidPresets[item.id],
                ...(selected === item.id
                  ? { draftValid: valid, evidenceChanged: stale }
                  : {}),
                dirty,
                busy,
                now,
              });
              const expanded = selected === item.id;
              return (
                <Fragment key={item.id}>
                  <tr
                    className={`routine-comparison-row ${expanded ? "selected" : ""}`}
                    data-routine-row={item.id}
                  >
                    <th scope="row" data-label="Routine">
                      <button
                        data-routine-id={item.id}
                        className="routine-choice"
                        aria-expanded={expanded}
                        aria-controls={expanded ? "routine-detail" : undefined}
                        onClick={() => choose(item, undefined, true)}
                      >
                        <ChevronDown size={16} aria-hidden="true" />
                        <strong>{item.label}</strong>
                      </button>
                      <p className="routine-explanation">{view.explanation}</p>
                      <span className={`routine-status ${entry.status}`}>
                        {statusLabels[entry.status]}
                      </span>
                    </th>
                    <td data-label="Recorded size">
                      <span className="routine-potential">
                        {!summary || summary.knownBytes === null
                          ? "Size unknown"
                          : `${summary.estimated ? "≈ " : ""}${folderBytes(summary.knownBytes)} recorded`}
                      </span>
                      {summary && (
                        <small>
                          {summary.candidateCount} matching folders ·{" "}
                          {summary.unknownSizeCount} unknown size
                          {summary.estimated ? " · Estimated" : ""}
                          {summary.incomplete ? " · Incomplete sizes" : ""}
                        </small>
                      )}
                    </td>
                    <td data-label="What you can do">
                      <button
                        className={
                          view.action.kind === "review-folders"
                            ? "primary small"
                            : "secondary small"
                        }
                        disabled={view.action.disabled}
                        onClick={() => compactAction(entry, view.action.kind)}
                      >
                        {view.action.label}
                      </button>
                      {view.action.reason &&
                        (entry.status !== "not-run" ||
                          view.action.disabled) && (
                          <p className="routine-action-reason">
                            {view.action.reason}
                          </p>
                        )}
                      {entry.run && view.counts.reviewOnly > 0 && (
                        <small>
                          {view.counts.eligibleForReview} eligible for review ·{" "}
                          {view.counts.reviewOnly} review only
                        </small>
                      )}
                    </td>
                    <td data-label="Risk">
                      <p className="routine-risk">{view.risk}</p>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="routine-expansion-row">
                      <td colSpan={4}>{details}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!catalog && !error && (
          <p className="routine-padding" role="status">
            Loading routines…
          </p>
        )}
      </div>
    </div>
  );
}
