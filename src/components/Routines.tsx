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
const modes = {
  "in-app": "In-app review",
  guided: "Guided maintenance",
  "review-only": "Review only",
};
const signature = (value: RoutinePreset) => JSON.stringify(value);
export function Routines({
  api,
  scanId,
  onPrepare,
}: {
  api: (route: string, body?: unknown) => Promise<any>;
  scanId?: string;
  onPrepare: (request: { runId: string; candidateId: string }) => void;
}) {
  const [catalog, setCatalog] = useState<RoutineCatalog | null>(null);
  const [selected, setSelected] = useState("generated-output");
  const [draft, setDraft] = useState<RoutinePreset | null>(null);
  const [rootText, setRootText] = useState("");
  const [run, setRun] = useState<RoutineRun | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    setExpired(false);
    if (!run) return;
    const timer = window.setTimeout(() => setExpired(true), 300000);
    return () => window.clearTimeout(timer);
  }, [run?.id]);
  useEffect(() => {
    let live = true;
    api("routines")
      .then((next: RoutineCatalog) => {
        if (live) {
          setCatalog(next);
          setDraft(next.presets[selected]);
          setRootText(next.presets[selected].roots.join("\n"));
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      revision.current++;
    };
  }, []);
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
  const invalidPreset = catalog?.invalidPresets[selected];
  async function action(save: boolean) {
    if (!draft || !valid || (!save && invalidPreset)) return;
    const current = ++revision.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (save) {
        const next: RoutineCatalog = await api("routines/presets", draft);
        if (current === revision.current) {
          setCatalog(next);
          setDraft(next.presets[selected]);
          setRootText(next.presets[selected].roots.join("\n"));
          setRun(null);
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
          setRun(next);
          setDraft(next.parameters);
          setRootText(next.parameters.roots.join("\n"));
        }
      }
    } catch (e) {
      if (current === revision.current) setError((e as Error).message);
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  function choose(item: RoutineDefinition) {
    revision.current++;
    setSelected(item.id);
    setDraft(catalog!.presets[item.id]);
    setRootText(catalog!.presets[item.id].roots.join("\n"));
    setRun(null);
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
      <div className="routine-directory panel" aria-label="Cleanup routines">
        <div className="panel-heading">
          <div>
            <h2>Choose a routine</h2>
            <p>Repeat the review. Keep the rebuild in view.</p>
          </div>
        </div>
        {catalog?.definitions.map((item) => (
          <button
            key={item.id}
            className={`routine-choice ${selected === item.id ? "selected" : ""}`}
            aria-pressed={selected === item.id}
            disabled={busy}
            onClick={() => choose(item)}
          >
            <strong>{item.label}</strong>
            <span className={`routine-mode ${item.mode}`}>
              {modes[item.mode]}
            </span>
            <small>{item.recoveryCost} recovery cost</small>
          </button>
        ))}
        {!catalog && !error && (
          <p className="routine-padding" role="status">
            Loading routines…
          </p>
        )}
      </div>
      <section className="panel routine-detail" aria-label="Selected routine">
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
                  <RefreshCw size={15} className={busy ? "spin" : ""} />
                  {busy ? "Checking…" : "Run routine check"}
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
                Run evidence expired. Run the routine again before reviewing
                cleanup.
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
                  <span>
                    Checked {new Date(run.checkedAt).toLocaleString()}
                  </span>
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
                      {candidate.logicalBytes === null
                        ? "Size unknown"
                        : `${candidate.estimated ? "≈ " : ""}${folderBytes(candidate.logicalBytes)}`}
                      <small>
                        {candidate.recordedAt
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
                          onClick={() =>
                            onPrepare({
                              runId: run.id,
                              candidateId: candidate.id,
                            })
                          }
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
