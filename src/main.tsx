import { useEffect, useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderGit2,
  HardDrive,
  History,
  LoaderCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Square,
  TriangleAlert,
  CheckCircle2,
} from "lucide-react";
import { ScanDialog } from "./components/ScanDialog";
import { CoverageDialog } from "./components/CoverageDialog";
import { CleanupDialog } from "./components/CleanupDialog";
import { LargeFolders } from "./components/LargeFolders";
import { Routines } from "./components/Routines";
import { presentScanCoverage } from "./scan-coverage";
import { bytes, date, scanDelta } from "./types";
import type { Scan, State, Settings } from "./types";
import "./styles.css";
type View = "Folders" | "Routines" | "History" | "Settings";
type LoadState = "loading" | "empty" | "ready" | "failed";
function App() {
  const [state, setState] = useState<State | null>(null),
    [scan, setScan] = useState<Scan | null>(null),
    [view, setView] = useState<View>("Folders");
  const [workspaceStatus, setWorkspaceStatus] = useState<LoadState>("loading"),
    [reportStatus, setReportStatus] = useState<LoadState>("empty");
  const [failure, setFailure] = useState(""),
    [reportError, setReportError] = useState(""),
    [toast, setToast] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false),
    [exclusionDraft, setExclusionDraft] = useState(""),
    [developmentDraft, setDevelopmentDraft] = useState("");
  const [scanOpen, setScanOpen] = useState(false),
    [reportOpen, setReportOpen] = useState(false),
    [coverage, setCoverage] = useState(false);
  const [scanPreset, setScanPreset] = useState<{
    root?: string;
    folderMinBytes?: number;
  }>();
  const [cleanupRequest, setCleanupRequest] = useState<object | null>(null),
    [routineCleanupRequest, setRoutineCleanupRequest] = useState<{
      runId: string;
      candidateId: string;
    } | null>(null);
  const latest = useRef(""),
    loaded = useRef(false),
    token = useRef(""),
    reportRequest = useRef(0),
    selectedId = useRef(""),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scanCoverage = useMemo(
    () => (scan ? presentScanCoverage(scan) : null),
    [scan],
  );
  const folderScans =
    state?.scans.filter((s) => s.operation === "folder-sizes") || [];
  const changedSinceScan = useMemo(() => {
    if (!scan) return false;
    const norm = (s: string) => {
      const p = s.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
      return /^[a-z]:/i.test(p) ? p.toLowerCase() : p;
    };
    const root = norm(scan.root),
      prefix = root.endsWith("/") ? root : root + "/",
      measured = Date.parse(scan.completedAt || scan.startedAt);
    return (state?.cleanups || []).some((r) => {
      if (
        !["deleted", "partial"].includes(r.status) ||
        !(r.deletedFiles > 0 || r.deletedBytes > 0) ||
        Date.parse(r.completedAt || r.startedAt) <= measured
      )
        return false;
      const target = norm(r.path),
        tp = target.endsWith("/") ? target : target + "/";
      return (
        target === root || target.startsWith(prefix) || root.startsWith(tp)
      );
    });
  }, [scan, state?.cleanups]);
  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }
  async function api(url: string, body?: unknown) {
    const r = await fetch(
      "/api/" + url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Reclaim-Token": token.current,
            },
            body: JSON.stringify(body),
          },
    );
    const data = await r.json();
    if (!r.ok)
      throw new Error(data.error || "The request could not be completed.");
    return data;
  }
  async function load(id: string) {
    const request = ++reportRequest.current;
    selectedId.current = id;
    setScan(null);
    setReportStatus("loading");
    setReportError("");
    setReportOpen(false);
    setCoverage(false);
    try {
      const result = await api("scans/" + encodeURIComponent(id));
      if (request !== reportRequest.current) return;
      if (
        !result.folderSizing ||
        result.folderSizing.accountingVersion !== 2 ||
        result.options?.operation !== "folder-sizes"
      )
        throw new Error("Unsupported report format. Start a new folder scan.");
      setScan(result);
      setReportStatus("ready");
    } catch (e) {
      if (request === reportRequest.current) {
        setReportError((e as Error).message);
        setReportStatus("failed");
      }
    }
  }
  useEffect(() => {
    let live = true,
      polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const next: State = await api("state");
        if (!live) return;
        token.current = next.token;
        setState(next);
        setWorkspaceStatus("ready");
        setFailure("");
        const current = next.scans.find((s) => s.operation === "folder-sizes");
        if (!loaded.current) {
          loaded.current = true;
          setSettings(next.settings);
          setExclusionDraft(next.settings.exclusions.join("\n"));
          setDevelopmentDraft(next.settings.developmentRoots.join("\n"));
          latest.current = current?.id || "";
          if (current) void load(current.id);
        } else if (current && current.id !== latest.current) {
          latest.current = current.id;
          void load(current.id);
          notify("Scan ready to explore");
        } else if (!current && latest.current) {
          latest.current = "";
          selectedId.current = "";
          ++reportRequest.current;
          setScan(null);
          setReportStatus("empty");
          setReportError("");
        }
      } catch (e) {
        if (live) {
          setWorkspaceStatus("failed");
          setFailure((e as Error).message);
        }
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
      ++reportRequest.current;
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!reportOpen) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".report-control"))
        setReportOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReportOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [reportOpen]);
  function navigate(next: View) {
    setView(next);
    setReportOpen(false);
  }
  async function reveal(path: string) {
    if (!scan) return;
    try {
      await api("reveal", { scanId: scan.id, path });
      notify("Folder requested in your file manager");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function exportReport(format: "csv" | "json") {
    if (!scan) return;
    try {
      const r = await fetch(
        `/api/scans/${encodeURIComponent(scan.id)}/report.${format}`,
      );
      if (!r.ok) {
        const data = await r.json();
        throw new Error(
          data.error || "Report unavailable. Start a new folder scan.",
        );
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `reclaim-report.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Report exported");
    } catch (e) {
      notify((e as Error).message);
    }
    setReportOpen(false);
  }
  const canScan =
    !!state && !state.job && !state.cleanupBusy && workspaceStatus === "ready";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("Folders");
          }}
        >
          <img src="/favicon.svg" alt="" />
          <span>
            reclaim<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="rail-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {(
            [
              ["Folders", FolderOpen],
              ["Routines", ShieldCheck],
              ["History", History],
            ] as const
          ).map(([label, Icon]) => (
            <button
              key={label}
              title={label}
              aria-current={view === label ? "page" : undefined}
              className={view === label ? "active" : ""}
              onClick={() => navigate(label)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-note">
          <div className="orb">
            <HardDrive size={22} />
          </div>
          {scan?.disk ? (
            <>
              <strong>{bytes(scan.disk.free)} free</strong>
              <p>
                {bytes(scan.disk.total)} drive capacity
                <br />
                Snapshot at last scan
              </p>
            </>
          ) : (
            <>
              <strong>A clearer picture.</strong>
              <p>
                Find what’s taking space.
                <br />
                Decide what stays.
              </p>
            </>
          )}
          <button disabled={!canScan} onClick={() => setScanOpen(true)}>
            Scan a folder <Plus size={15} />
          </button>
        </div>
        <div className="rail-bottom">
          <button
            title="Settings"
            aria-label="Scan settings"
            className={view === "Settings" ? "active" : ""}
            onClick={() => navigate("Settings")}
          >
            <Settings2 size={18} />
            Settings
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <HardDrive size={16} />
            <span>Local workspace</span>
            <ChevronRight size={14} />
            <b>{view}</b>
          </div>
          <div className="top-actions">
            <button
              className="icon-btn mobile-settings"
              aria-label="Scan settings"
              onClick={() => navigate("Settings")}
            >
              <Settings2 size={17} />
            </button>
            <span className="read-only">
              <ShieldCheck size={14} /> Read-only analysis
            </span>
            <button
              className="primary small"
              disabled={!canScan}
              onClick={() => setScanOpen(true)}
            >
              <Plus size={16} />
              New scan
            </button>
          </div>
        </header>
        <main>
          {failure && (
            <div className="alert error" role="alert">
              <TriangleAlert size={18} />
              {failure} Check the local service connection. Retrying…
            </div>
          )}
          {state?.job && (
            <div className="scan-progress" role="status">
              <LoaderCircle className="spin" size={20} />
              <div>
                <strong>{state.job.progress.phase}</strong>
                <small>
                  {state.job.progress.fileCount.toLocaleString()} files ·{" "}
                  {bytes(state.job.progress.totalBytes)} ·{" "}
                  {state.job.progress.current}
                </small>
                <div className="indeterminate" />
              </div>
              <button
                className="secondary small"
                onClick={() =>
                  void api("cancel").catch((e) => notify(e.message))
                }
              >
                <Square size={13} />
                Stop scan
              </button>
            </div>
          )}
          {state?.lastError && (
            <div className="alert error" role="alert">
              <TriangleAlert size={18} />
              Last scan failed: {state.lastError}
            </div>
          )}
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                {scan
                  ? `FOLDER SCAN · ${date(scan.completedAt)}`
                  : "LOCAL WORKSPACE"}
              </div>
              <h1>{view}</h1>
              <p>
                {
                  {
                    Folders:
                      "Every folder above your size threshold, across the selected search area.",
                    Routines:
                      "Repeat a useful cleanup review. Know the scope and the cost of rebuilding.",
                    History: "See how your storage changes over time.",
                    Settings: "Make every scan work the way you do.",
                  }[view]
                }
              </p>
            </div>
            {scan && (
              <div className="heading-actions">
                <div className="report-control">
                  <button
                    className="secondary"
                    onClick={() => setReportOpen(!reportOpen)}
                    aria-expanded={reportOpen}
                  >
                    <ArrowDownToLine size={16} />
                    Export report
                    <ChevronDown size={14} />
                  </button>
                  {reportOpen && (
                    <div className="dropdown">
                      <button onClick={() => void exportReport("csv")}>
                        Spreadsheet (.csv)
                      </button>
                      <button onClick={() => void exportReport("json")}>
                        Full report (.json)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
          {workspaceStatus === "loading" && (
            <div className="empty" role="status">
              <LoaderCircle className="spin" size={28} />
              <p>Loading workspace…</p>
            </div>
          )}
          {view === "Folders" && workspaceStatus !== "loading" && (
            <>
              {reportStatus === "loading" && (
                <div className="empty" role="status">
                  <LoaderCircle className="spin" size={28} />
                  <p>Loading folder report…</p>
                </div>
              )}
              {reportStatus === "failed" && (
                <div className="panel empty" role="alert">
                  <TriangleAlert size={28} />
                  <h2>Folder report unavailable</h2>
                  <p>{reportError}</p>
                  <button
                    className="secondary"
                    onClick={() => void load(selectedId.current)}
                  >
                    Retry report
                  </button>
                  <button
                    className="primary"
                    disabled={!canScan}
                    onClick={() => setScanOpen(true)}
                  >
                    Start a new scan
                  </button>
                </div>
              )}
              {reportStatus === "empty" && workspaceStatus === "ready" && (
                <section className="panel empty">
                  <FolderOpen size={36} />
                  <h2>No folder scans yet</h2>
                  <p>
                    Scan a folder to explore its size. Your saved scans will
                    appear here.
                  </p>
                  <button
                    className="primary"
                    disabled={!canScan}
                    onClick={() => setScanOpen(true)}
                  >
                    Scan a folder
                  </button>
                </section>
              )}
              {scan && (
                <>
                  {scanCoverage?.showBanner && (
                    <div className="alert">
                      <TriangleAlert size={18} />
                      {scanCoverage.summary}
                      <button onClick={() => setCoverage(true)}>
                        View coverage
                      </button>
                    </div>
                  )}
                  <LargeFolders
                    key={scan.id}
                    scan={scan}
                    onFindIgnored={(minimumBytes) =>
                      api("folders/ignored", { scanId: scan.id, minimumBytes })
                    }
                    onInspect={(path, offset = 0) =>
                      api("folders/inspect", {
                        scanId: scan.id,
                        path,
                        offset,
                        limit: 100,
                      })
                    }
                    onReveal={reveal}
                    onPrepare={setCleanupRequest}
                    changedSinceScan={changedSinceScan}
                    onScan={(folderMinBytes) => {
                      setScanPreset({ root: scan.root, folderMinBytes });
                      setScanOpen(true);
                    }}
                  />
                </>
              )}
            </>
          )}
          {view === "History" && state && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Your scan timeline</h2>
                  <p>Folder reports are saved on this computer.</p>
                </div>
              </div>
              {folderScans.length ? (
                folderScans.map((s, i) => {
                  const previous = folderScans
                    .slice(i + 1)
                    .find((old) => old.root === s.root);
                  const delta = previous ? scanDelta(s, previous) : null;
                  return (
                    <button
                      className="history-row"
                      key={s.id}
                      onClick={() => {
                        navigate("Folders");
                        void load(s.id);
                      }}
                    >
                      <span className="file-symbol">
                        <Folder size={20} />
                      </span>
                      <span className="history-name">
                        <strong>{s.name}</strong>
                        <small>{s.root}</small>
                      </span>
                      <span>
                        <b>{bytes(s.totalBytes)}</b>
                        <small>
                          {delta === null
                            ? previous
                              ? "Coverage changed; no comparison"
                              : "First scan here"
                            : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${bytes(Math.abs(delta))} since previous`}
                        </small>
                      </span>
                      <span>
                        <b>Folder totals</b>
                        <small>Recursive logical size</small>
                      </span>
                      <span>
                        <b>{date(s.completedAt)}</b>
                        <small>{s.status}</small>
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  );
                })
              ) : (
                <div className="empty">
                  <History size={36} />
                  <h3>A fresh start</h3>
                  <p>
                    Run your first scan to build a picture of your storage over
                    time.
                  </p>
                  <button
                    className="primary"
                    disabled={!canScan}
                    onClick={() => setScanOpen(true)}
                  >
                    Start first scan
                  </button>
                </div>
              )}
            </section>
          )}
          {view === "Routines" && state && (
            <Routines
              key={scan?.id || "no-report"}
              api={api}
              scanId={scan?.id}
              onPrepare={setRoutineCleanupRequest}
            />
          )}
          {view === "Settings" && settings && (
            <form
              className="settings-layout"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const saved = await api("settings", {
                    ...settings,
                    developmentRoots: developmentDraft
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    exclusions: exclusionDraft
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  });
                  setSettings(saved);
                  setExclusionDraft(saved.exclusions.join("\n"));
                  setDevelopmentDraft(saved.developmentRoots.join("\n"));
                  notify("Scan settings saved");
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div>
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Keep out of scans</h2>
                      <p>Folder names or absolute paths, one per line.</p>
                    </div>
                    <ShieldCheck size={20} />
                  </div>
                  <div className="settings-body">
                    <label htmlFor="exclusions" className="input-label">
                      Exclusions
                    </label>
                    <textarea
                      id="exclusions"
                      rows={7}
                      placeholder={"backups\nC:\\Projects\\important-archive"}
                      value={exclusionDraft}
                      onChange={(e) => setExclusionDraft(e.target.value)}
                    />
                    <label className="switch-row">
                      <div>
                        <strong>Exclude OneDrive folders</strong>
                        <small>
                          Cloud placeholders and reparse points are always
                          skipped.
                        </small>
                      </div>
                      <input
                        type="checkbox"
                        checked={settings.skipCloud}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            skipCloud: e.target.checked,
                          })
                        }
                      />
                    </label>
                    <p className="settings-note">
                      Windows system folders, filesystem links, and offline
                      files are skipped automatically. Folder totals scans have
                      no file or directory cap.
                    </p>
                  </div>
                </section>
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Development projects</h2>
                      <p>
                        Find build output, installed modules and registered Git
                        worktrees.
                      </p>
                    </div>
                    <FolderGit2 size={20} />
                  </div>
                  <div className="settings-body">
                    <label className="input-label" htmlFor="development-roots">
                      Development folders
                    </label>
                    <textarea
                      id="development-roots"
                      rows={4}
                      placeholder={"~/repos\nD:\\Projects"}
                      value={developmentDraft}
                      onChange={(e) => setDevelopmentDraft(e.target.value)}
                    />
                    <small>
                      One local project folder per line. ~/ expands to your home
                      folder. These also become scan shortcuts.
                    </small>
                    <p className="settings-note">
                      Build folders need project evidence. Worktrees need clean
                      local content and a preserved commit. Nothing is deleted
                      without a fresh preview and typed confirmation.
                    </p>
                  </div>
                </section>
                <div className="settings-save">
                  <span>Stored locally on this computer</span>
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || !state}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Check size={16} />
                    )}
                    Save settings
                  </button>
                </div>
              </div>
            </form>
          )}
        </main>
        <footer className="app-footer">
          <span>
            <span className="brand-mini">reclaim.</span> A little clarity goes a
            long way.
          </span>
          <span>
            <ShieldCheck size={13} />
            Your data stays on this computer
          </span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {scanOpen && settings && (
        <ScanDialog
          state={state}
          settings={settings}
          busy={busy}
          setBusy={setBusy}
          preset={scanPreset}
          onClose={() => {
            setScanOpen(false);
            setScanPreset(undefined);
          }}
          onStart={async (options) => {
            await api("scans", options);
            setScanOpen(false);
            setScanPreset(undefined);
            navigate("Folders");
            notify("Scan started");
          }}
        />
      )}
      {coverage && scan && (
        <CoverageDialog scan={scan} onClose={() => setCoverage(false)} />
      )}
      {(cleanupRequest || routineCleanupRequest) && (
        <CleanupDialog
          request={routineCleanupRequest || cleanupRequest!}
          prepare={
            routineCleanupRequest
              ? (request) => api("routines/candidates/prepare", request)
              : undefined
          }
          api={api}
          onClose={() => {
            setCleanupRequest(null);
            setRoutineCleanupRequest(null);
          }}
          onDone={(result) => {
            void api("state")
              .then((next: State) => setState(next))
              .catch((e) => notify("Refresh failed: " + e.message));
            notify(
              result.status === "deleted"
                ? "Deleted permanently; recorded in cleanup history"
                : "Cleanup stopped. Review the result.",
            );
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
