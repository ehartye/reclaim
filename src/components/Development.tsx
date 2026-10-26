import { useEffect, useState, useRef } from "react";
import {
  FolderGit2,
  RefreshCw,
  Search,
  ArrowUpRight,
  LoaderCircle,
} from "lucide-react";
import { bytes, date } from "../types";
import { OpportunityPlanner } from "./OpportunityPlanner";
import type {
  DevelopmentInventory,
  CleanupRecord,
  Settings,
  Finding,
} from "../types";
export function Development({
  api,
  settings,
  findings,
  records,
  onPrepare,
  onSettings,
  request,
  onReset,
  onSettingsSaved,
}: {
  api: (url: string, body?: unknown) => Promise<any>;
  settings: Settings;
  findings: Finding[];
  records: CleanupRecord[];
  onPrepare: (request: object) => void;
  onSettings: () => void;
  request: { root?: string; operation?: string };
  onReset: () => void;
  onSettingsSaved: (settings: Settings) => void;
}) {
  const [inventory, setInventory] = useState<DevelopmentInventory | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [query, setQuery] = useState("");
  const [kind, setKind] = useState(request.operation || "all"),
    [olderOnly, setOlderOnly] = useState(false);
  const revision = useRef(0);
  const cleanupRevision = records
    .map((r) => `${r.id}:${r.status}:${r.completedAt || ""}`)
    .join("|");
  const previousCleanup = useRef(cleanupRevision);
  useEffect(() => {
    if (previousCleanup.current === cleanupRevision) return;
    previousCleanup.current = cleanupRevision;
    setInventory((previous) =>
      previous ? { ...previous, targets: [] } : null,
    );
    void refresh(kind);
  }, [cleanupRevision]);
  async function refresh(operation = kind) {
    const current = ++revision.current;
    let finished = false,
      quickPending = false;
    setLoading(true);
    setError("");
    const body = { operation, ...(request.root ? { root: request.root } : {}) };
    const quick = async () => {
      if (quickPending || finished || revision.current !== current) return;
      quickPending = true;
      try {
        const next: DevelopmentInventory = await api("development/quick", body);
        if (!finished && revision.current === current) setInventory(next);
      } catch {
      } finally {
        quickPending = false;
      }
    };
    const timer = setInterval(() => void quick(), 2000);
    try {
      await quick();
      const next = await api("development", body);
      finished = true;
      if (revision.current === current) setInventory(next);
    } catch (e) {
      if (revision.current === current) setError((e as Error).message);
    } finally {
      finished = true;
      clearInterval(timer);
      if (revision.current === current) setLoading(false);
    }
  }
  useEffect(() => {
    const operation = request.operation || "all";
    setKind(operation);
    setOlderOnly(false);
    void refresh(operation);
    return () => {
      revision.current++;
    };
  }, [request]);
  const targets =
    inventory?.targets.filter(
      (t) =>
        (!olderOnly ||
          (t.lastCommitAt &&
            Date.now() - Date.parse(t.lastCommitAt) >
              settings.staleDays * 86400000)) &&
        (t.path + " " + t.label + " " + (t.branch || ""))
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) || [];
  return (
    <div className="development-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Productive cleanup scenarios</h2>
            <p>
              Rank likely gains, check generated activity, and understand the
              rebuild.
            </p>
          </div>
          <button
            className="secondary small"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} /> Refresh projects
          </button>
        </div>
        <div className="development-roots">
          {(request.root ? [request.root] : settings.developmentRoots).map(
            (p) => (
              <code key={p}>{p}</code>
            ),
          )}
          <button className="text-btn" onClick={onSettings}>
            Configure folders <ArrowUpRight size={14} />
          </button>
          {request.root && (
            <button className="text-btn" onClick={onReset}>
              Use configured folders
            </button>
          )}
        </div>
        <div className="development-filter">
          <Search size={17} />
          <input
            aria-label="Search development folders"
            placeholder="Find a project, output folder or branch"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Discovery operation"
            value={kind}
            disabled={loading}
            onChange={(e) => {
              setKind(e.target.value);
              setOlderOnly(false);
              void refresh(e.target.value);
            }}
          >
            <option value="all">All cleanup folder types</option>
            <option value="worktrees">Git worktrees</option>
            <option value="stale-worktrees">Older Git worktrees</option>
            <option value="builds">Build directories</option>
            <option value="dependencies">node_modules & environments</option>
            <option value="caches">Cache directories</option>
          </select>
          {["all", "worktrees"].includes(kind) && (
            <label className="development-older">
              <input
                type="checkbox"
                checked={olderOnly}
                onChange={(e) => {
                  setOlderOnly(e.target.checked);
                }}
              />{" "}
              Last commit over {settings.staleDays} days ago
            </label>
          )}
        </div>
        {inventory && (
          <div className="discovery-coverage" role="status">
            <strong>
              {inventory.source === "saved"
                ? "Quick look — recorded estimates; current discovery continues"
                : inventory.coverage.complete
                  ? "Discovery complete for these folder rules"
                  : "Partial discovery — review coverage notices"}
            </strong>
            <span>
              {inventory.source === "saved"
                ? "Saved sizes are dated estimates, not a fresh exhaustive inventory. "
                : ""}
              {inventory.coverage.directoriesVisited.toLocaleString()}{" "}
              directories checked ·{" "}
              {inventory.coverage.skippedSubtrees.toLocaleString()} subtrees
              skipped · generated contents are not counted against the full-scan
              file limit
            </span>
          </div>
        )}
        {loading && (
          <div
            className={
              inventory?.targets.length ? "intelligence-status" : "empty"
            }
            role="status"
          >
            <LoaderCircle size={24} className="spin" />
            <p>
              {inventory?.targets.length
                ? "Looking for additional folders in the background…"
                : "Discovering project outputs and Git worktrees…"}
            </p>
          </div>
        )}
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {!loading && !targets.length && (
          <div className="empty">
            <FolderGit2 size={32} />
            <h3>No matching development folders</h3>
            <p>
              Add the folders containing your projects in Settings, then
              refresh.
            </p>
          </div>
        )}
        {inventory && (
          <OpportunityPlanner
            targets={targets}
            operation={kind}
            api={api}
            settings={settings}
            onSettingsSaved={onSettingsSaved}
            onPrepare={onPrepare}
          />
        )}
        {inventory && (
          <div className="table-footer">
            <span>
              {inventory.projects.length} project checkouts ·{" "}
              {inventory.targets.length} cleanup leads
            </span>
            <span>Age is a review hint, not proof of inactivity</span>
          </div>
        )}
        {inventory?.notices.length ? (
          <details className="development-notices">
            <summary>
              Discovery coverage ({inventory.notices.length} notices)
            </summary>
            {inventory.notices.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </details>
        ) : null}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Cleanup history</h2>
            <p>
              Actual operations are recorded separately from scan estimates.
            </p>
          </div>
        </div>
        {records.length ? (
          records.map((r) => (
            <div className="cleanup-history" key={r.id}>
              <strong>
                {r.status === "started"
                  ? "Interrupted or still running — inspect target"
                  : r.status}
              </strong>
              <p className="detail-path">{r.path}</p>
              <small>
                {date(r.completedAt || r.startedAt)} · {r.deletedFiles} files ·{" "}
                {bytes(r.deletedBytes)} logical bytes
                {r.error ? " · " + r.error : ""}
              </small>
            </div>
          ))
        ) : (
          <div className="empty">
            <p>
              No cleanup operations yet. Previewing or cancelling does not
              delete files.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
