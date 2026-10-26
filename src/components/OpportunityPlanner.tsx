import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, LoaderCircle, Ruler, Square } from "lucide-react";
import {
  evaluateOpportunity,
  opportunityTotals,
  compareOpportunities,
} from "../../shared/opportunities.ts";
import type {
  DevelopmentTarget,
  Settings,
  IntelligenceSnapshot,
} from "../types";
import { bytes } from "../types";
const evidenceDate = (value: string | number) =>
  new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export function OpportunityPlanner({
  targets,
  operation,
  api,
  settings,
  onSettingsSaved,
  onPrepare,
}: {
  targets: DevelopmentTarget[];
  operation: string;
  api: (url: string, body?: unknown) => Promise<any>;
  settings: Settings;
  onSettingsSaved: (settings: Settings) => void;
  onPrepare: (request: object) => void;
}) {
  const [snapshot, setSnapshot] = useState<IntelligenceSnapshot | null>(null),
    [failure, setFailure] = useState(""),
    [recipe, setRecipe] = useState("largest"),
    [olderDays, setOlderDays] = useState(settings.opportunityAgeDays),
    [minimumMB, setMinimumMB] = useState(
      settings.opportunityMinBytes / 1024 ** 2,
    ),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [limit, setLimit] = useState(40),
    [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setRecipe(
      ["caches", "worktrees", "stale-worktrees"].includes(operation)
        ? "all"
        : "largest",
    );
    setSelected(new Set());
    setLimit(40);
  }, [operation]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api("intelligence");
        if (live) {
          setSnapshot(next);
          setFailure("");
        }
      } catch (e) {
        if (live) setFailure((e as Error).message);
      } finally {
        if (live) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  const candidates = useMemo(
    () =>
      targets
        .map((target) =>
          evaluateOpportunity(
            target,
            {
              activity: target.activity,
              changes: snapshot?.changes,
              recorded: snapshot?.index.records[target.id] || target.recorded,
              measurement: snapshot?.measurements[target.id],
            },
            {
              recipe,
              olderDays: Number.isFinite(olderDays) ? olderDays : 30,
              minimumBytes:
                (Number.isFinite(minimumMB) ? minimumMB : 100) * 1024 ** 2,
            },
          ),
        )
        .sort(compareOpportunities),
    [targets, snapshot, recipe, olderDays, minimumMB],
  );
  const visible = candidates.filter((c) => c.visible),
    chosen = visible.filter((c) => selected.has(c.id)),
    totals = opportunityTotals(chosen.length ? chosen : visible),
    job = snapshot?.measurementJob;
  const recentCount = candidates.filter(
    (c) => c.ageState === "recent" && !c.visible,
  ).length;
  async function saveRules() {
    try {
      const saved: Settings = await api("settings", {
        opportunityAgeDays: olderDays,
        opportunityMinBytes: Math.round(minimumMB * 1024 ** 2),
      });
      onSettingsSaved(saved);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  async function measure(ids: string[]) {
    setSubmitting(true);
    setFailure("");
    try {
      await api("measurements/start", { targetIds: ids });
      setSnapshot(await api("intelligence"));
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  const top = visible
    .filter((c) => c.target.cleanupSupported && (!c.fresh || c.partial))
    .slice(0, 5);
  return (
    <div className="opportunity-planner">
      <div className="opportunity-controls">
        <div>
          <label htmlFor="cleanup-recipe">Productive scenario</label>
          <select
            id="cleanup-recipe"
            value={recipe}
            onChange={(e) => {
              setRecipe(e.target.value);
              setLimit(40);
            }}
          >
            {["all", "builds", "dependencies"].includes(operation) && (
              <option value="largest">Largest rebuildable folders</option>
            )}
            {["all", "dependencies"].includes(operation) && (
              <option value="old-dependencies">Old dependencies</option>
            )}
            {["all", "builds"].includes(operation) && (
              <option value="old-builds">Old build output</option>
            )}
            <option value="all">
              All folder leads, including manual review
            </option>
          </select>
        </div>
        <div>
          <label htmlFor="generated-age">Generated activity older than</label>
          <div className="numeric-unit">
            <input
              id="generated-age"
              type="number"
              min={0}
              max={36500}
              value={olderDays}
              disabled={!recipe.startsWith("old-")}
              onChange={(e) => setOlderDays(+e.target.value)}
              onBlur={() => void saveRules()}
            />
            <span>days</span>
          </div>
        </div>
        <div>
          <label htmlFor="minimum-gain">Minimum estimated gain</label>
          <div className="numeric-unit">
            <input
              id="minimum-gain"
              type="number"
              min={0}
              max={1048576}
              value={minimumMB}
              onChange={(e) => setMinimumMB(+e.target.value)}
              onBlur={() => void saveRules()}
            />
            <span>MiB</span>
          </div>
        </div>
      </div>
      <div className="gain-summary">
        <div className="gain-primary">
          <span>
            {chosen.length ? "SELECTED SCENARIO" : "CURRENT MATCHES"} ·{" "}
            {totals.count} folders
          </span>
          <strong>
            {totals.measuredCount
              ? bytes(totals.measuredGainBytes)
              : "Measure to confirm gain"}
          </strong>
          <p>
            {totals.measuredCount
              ? "Fresh exclusive allocated data; known shared hardlinks excluded."
              : "Use saved estimates to shortlist, then verify promising folders."}
          </p>
        </div>
        <div className="gain-recorded">
          <span>Recorded logical estimate</span>
          <strong>
            {totals.recordedCount
              ? bytes(totals.recordedLogicalBytes)
              : "No recorded-only estimate"}
          </strong>
          <p>
            {totals.recordedCount
              ? "Historical estimate; partial coverage and changed contents can affect it."
              : `${totals.pendingCount} folders still need verification.`}
          </p>
        </div>
      </div>
      <div className="opportunity-actions">
        <div>
          <button
            className="primary small"
            disabled={!!job || submitting || !top.length}
            onClick={() => void measure(top.map((c) => c.id))}
          >
            <Ruler size={15} />
            {submitting
              ? "Starting…"
              : `Verify top ${top.length || 5} candidates`}
          </button>
          {chosen.length > 0 && (
            <button
              className="secondary small"
              disabled={!!job || submitting || chosen.length > 20}
              onClick={() => void measure(chosen.map((c) => c.id))}
            >
              Measure selected ({chosen.length})
            </button>
          )}
        </div>
        <span>
          Read-only checks · 60 seconds per folder · overlaps counted once
        </span>
      </div>
      <p className="opportunity-explainer">
        Age means the newest observed creation or write in the generated folder,
        not last use. Folder/install markers are hints; complete fresh
        inspection confirms the age. Old package timestamps and old Git commits
        alone do not prove disuse. Sizes remain estimates; metadata and
        alternate streams are outside the allocation total.
      </p>
      {snapshot?.index.status === "building" && (
        <p className="intelligence-status" role="status">
          <LoaderCircle className="spin" size={15} /> Preparing saved estimates{" "}
          {snapshot.index.progress.done}/{snapshot.index.progress.total} in the
          background…
        </p>
      )}
      {snapshot?.index.error && (
        <p className="alert error" role="alert">
          Some saved estimates could not be loaded: {snapshot.index.error} You
          can still measure individual candidates.
        </p>
      )}
      {(failure || snapshot?.measurementError) && (
        <p className="alert error" role="alert">
          {failure || snapshot?.measurementError}
        </p>
      )}
      {job && (
        <div className="measurement-progress" role="status">
          <LoaderCircle size={18} className="spin" />
          <div>
            <strong>
              Verifying candidate {Math.min(job.done + 1, job.total)} of{" "}
              {job.total}
            </strong>
            <p className="detail-path">{job.path}</p>
            <small>
              {(job.progress?.fileCount || 0).toLocaleString()} files measured
            </small>
          </div>
          <button
            className="secondary small"
            onClick={() =>
              void api("measurements/cancel", {}).catch((e) =>
                setFailure(e.message),
              )
            }
          >
            <Square size={13} />
            Cancel check
          </button>
        </div>
      )}
      {!visible.length && (
        <div className="empty">
          <Ruler size={30} />
          <h3>No matching deletion scenario yet</h3>
          <p>
            {recentCount
              ? `${recentCount} folders show recent activity. Change the age threshold or inspect the largest folders.`
              : "Lower the minimum or choose all leads. Unmeasured candidates stay visible rather than being assumed small."}
          </p>
          <button className="secondary small" onClick={() => setRecipe("all")}>
            Show all folder leads
          </button>
        </div>
      )}
      {visible.slice(0, limit).map((candidate) => {
        const t = candidate.target as DevelopmentTarget,
          m = candidate.evidence.measurement,
          r = candidate.evidence.recorded;
        return (
          <article className="development-target productive-target" key={t.id}>
            <div className="productive-target-heading">
              <label className="scenario-select">
                <input
                  type="checkbox"
                  aria-label={`Include ${t.path} in gain estimate`}
                  checked={selected.has(t.id)}
                  onChange={(e) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      e.target.checked ? next.add(t.id) : next.delete(t.id);
                      return next;
                    })
                  }
                />
                <span>
                  <small>{t.category.toUpperCase()}</small>
                  <h3>{t.label}</h3>
                </span>
              </label>
              <div className="candidate-gain">
                <strong>
                  {candidate.gainBytes === null
                    ? "Size unknown"
                    : bytes(candidate.gainBytes)}
                </strong>
                <span>
                  {candidate.gainBasis === "allocated"
                    ? candidate.partial
                      ? "Partial allocated estimate"
                      : "Exclusive allocated estimate"
                    : candidate.gainBasis === "recorded-logical"
                      ? "Saved logical estimate"
                      : "Measure to estimate gain"}
                </span>
              </div>
            </div>
            <p className="detail-path">{t.path}</p>
            <div className="candidate-evidence">
              <span
                className={
                  "activity-badge " +
                  (candidate.ageState === "confirmed-old" ? "old" : "hint")
                }
              >
                {candidate.ageState === "confirmed-old" ? (
                  <>
                    <Check size={13} />
                    No generated activity within {olderDays} days
                  </>
                ) : candidate.ageState === "recent" ? (
                  "Recently changed"
                ) : candidate.ageState === "possible-old" ? (
                  "Possibly older — verify contents"
                ) : (
                  "Age unknown — verify contents"
                )}
              </span>
              {!t.cleanupSupported && (
                <span className="risk review">
                  {t.blockedReason
                    ? "Protected — excluded from gain"
                    : "Manual review only"}
                </span>
              )}
              {t.locked && <span className="risk review">Locked worktree</span>}
            </div>
            <p className="candidate-date">
              {candidate.latestActivityAt
                ? "Latest activity signal: " +
                  evidenceDate(candidate.latestActivityAt)
                : "No reliable activity evidence yet."}
              {m
                ? " · " +
                  (m.status !== "complete"
                    ? m.status + " check "
                    : candidate.fresh
                      ? "Measured "
                      : "Previous measurement ") +
                  evidenceDate(m.measuredAt) +
                  (candidate.gainBasis === "recorded-logical" && r?.recordedAt
                    ? " · Estimate from scan " + evidenceDate(r.recordedAt)
                    : "")
                : r?.recordedAt
                  ? " · Scan " + evidenceDate(r.recordedAt)
                  : " · Fast folder/install-marker hints only"}
            </p>
            {candidate.partial && (
              <p className="measurement-limitation">
                Incomplete inspection or scan coverage; totals may be a lower
                bound and age is unconfirmed.
              </p>
            )}
            {m?.sharedAllocatedBytes ? (
              <p className="measurement-limitation">
                {bytes(m.sharedAllocatedBytes)} of allocated data has other
                hardlinks and is excluded from potential gain.
              </p>
            ) : null}
            <div className="restore-note">
              <strong>{candidate.restoreCost}</strong>
              <p>{t.restore}</p>
            </div>
            <details className="candidate-details">
              <summary>Why this scenario is suggested</summary>
              <p>{t.reason}</p>
              {t.activity?.evidence.map((e) => (
                <p key={e}>{e}</p>
              ))}
              {m?.notices.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </details>
            <div className="development-target-footer">
              <button
                className="secondary small"
                disabled={!!job || submitting}
                onClick={() => void measure([t.id])}
              >
                <Ruler size={14} />
                Measure size & activity
              </button>
              <button
                className="secondary small"
                disabled={!!job || !!t.locked || !t.cleanupSupported}
                onClick={() => onPrepare({ targetId: t.id })}
              >
                {t.cleanupSupported
                  ? "Review deletion"
                  : "Manual review required"}
                <ArrowUpRight size={15} />
              </button>
            </div>
          </article>
        );
      })}
      {visible.length > limit && (
        <div className="table-footer">
          <span>
            {limit} of {visible.length} matching scenarios
          </span>
          <button
            className="secondary small"
            onClick={() => setLimit(limit + 40)}
          >
            Show more scenarios
          </button>
        </div>
      )}
    </div>
  );
}
