import { normalizeReview, dispositionReview } from "../shared/review.ts";
import type { DispositionAction } from "../shared/review.ts";
import { ScanDialog } from "./components/ScanDialog";
import { OpportunityTable } from "./components/OpportunityTable";
import { FindingDrawer } from "./components/FindingDrawer";
import { CoverageDialog } from "./components/CoverageDialog";
import { CleanupDialog } from "./components/CleanupDialog";
import { Development } from "./components/Development";
import { LargeFolders } from "./components/LargeFolders";
import { useEffect, useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Files,
  Folder,
  FolderOpen,
  FolderGit2,
  HardDrive,
  Info,
  LayoutDashboard,
  LoaderCircle,
  Map,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  ExternalLink,
  TriangleAlert,
  Square,
  CheckCircle2,
  History,
  ArrowLeft,
} from "lucide-react";
import { sample, sampleSettings } from "./sample";
import { Treemap } from "./Treemap";
import {
  bytes,
  basename,
  parent,
  date,
  categories,
  queueBytes,
  categorySizes,
  scanDelta,
} from "./types";
import type { Scan, State, Finding, Review, Settings } from "./types";
import "./styles.css";

type View =
  | "Folders"
  | "Overview"
  | "Development"
  | "Opportunities"
  | "Space map"
  | "Duplicates"
  | "History"
  | "Settings"
  | "Review queue";
function App() {
  const [state, setState] = useState<State | null>(null),
    [scan, setScan] = useState<Scan>(sample),
    [view, setView] = useState<View>("Folders");
  const [review, setReview] = useState<Review>(normalizeReview()),
    [scanOpen, setScanOpen] = useState(false),
    [detail, setDetail] = useState<Finding | null>(null);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all"),
    [risk, setRisk] = useState("all"),
    [sort, setSort] = useState("priority"),
    [disposition, setDisposition] = useState("open");
  const [mapPath, setMapPath] = useState(sample.root),
    [toast, setToast] = useState(""),
    [failure, setFailure] = useState(""),
    [reportOpen, setReportOpen] = useState(false),
    [coverage, setCoverage] = useState(false);
  const [settings, setSettings] = useState<Settings>(sampleSettings),
    [busy, setBusy] = useState(false),
    [exclusionDraft, setExclusionDraft] = useState("");
  const [developmentDraft, setDevelopmentDraft] = useState("");
  const [discoveryRequest, setDiscoveryRequest] = useState<{
    root?: string;
    operation?: string;
  }>({});
  const [cleanupRequest, setCleanupRequest] = useState<object | null>(null);
  const [scanPreset, setScanPreset] = useState<{
    root?: string;
    operation?: string;
    folderMinBytes?: number;
  }>();
  const reviewRef = useRef<Review>(review),
    reviewWrites = useRef(Promise.resolve());
  const reviewCache = useRef(new globalThis.Map<string, Review>()),
    reviewSaveError = useRef("");
  const latest = useRef(""),
    loaded = useRef(false),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isSample = scan.id === "sample";
  const changedSinceScan = useMemo(() => {
    const normalizePath = (value: string) => {
      const clean = value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
      return /^[a-z]:/i.test(clean) ? clean.toLowerCase() : clean;
    };
    const root = normalizePath(scan.root),
      prefix = root.endsWith("/") ? root : root + "/";
    const measuredAt = Date.parse(scan.completedAt || scan.startedAt);
    return (state?.cleanups || []).some((record) => {
      if (
        !["deleted", "partial"].includes(record.status) ||
        !(record.deletedFiles > 0 || record.deletedBytes > 0) ||
        Date.parse(record.completedAt || record.startedAt) <= measuredAt
      )
        return false;
      const target = normalizePath(record.path),
        targetPrefix = target.endsWith("/") ? target : target + "/";
      return (
        target === root ||
        target.startsWith(prefix) ||
        root.startsWith(targetPrefix)
      );
    });
  }, [scan.root, scan.completedAt, scan.startedAt, state?.cleanups]);
  useEffect(() => {
    if (!reportOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".report-control"))
        setReportOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReportOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [reportOpen]);
  function notify(s: string) {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }
  async function api(url: string, body?: unknown) {
    if (url === "cleanup/execute") await reviewWrites.current;
    const r = await fetch(
      "/api/" + url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Reclaim-Token": state?.token || "",
            },
            body: JSON.stringify(body),
          },
    );
    const data = await r.json();
    if (!r.ok)
      throw new Error(data.error || "The request could not be completed.");
    return data;
  }
  async function load(id: string, next?: State) {
    const s = await api("scans/" + id);
    setScan(s);
    setView(s.folderSizing ? "Folders" : "Overview");
    setMapPath(s.root);
    reviewRef.current = normalizeReview(
      reviewCache.current.get(id) || (next || state)?.reviews[id],
    );
    setReview(reviewRef.current);
    setDetail(null);
  }
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/state");
        if (!r.ok) throw new Error("The local service is unavailable.");
        const next: State = await r.json();
        if (!live) return;
        setState(next);
        setFailure("");
        if (!loaded.current) {
          setSettings(next.settings);
          setExclusionDraft(next.settings.exclusions.join("\n"));
          setDevelopmentDraft(next.settings.developmentRoots.join("\n"));
          loaded.current = true;
          if (next.scans[0]) {
            latest.current = next.scans[0].id;
            const initialReport =
              next.scans.find(
                (report) => report.operation === "folder-sizes",
              ) || next.scans[0];
            await load(initialReport.id, next);
          }
        } else if (next.scans[0] && next.scans[0].id !== latest.current) {
          latest.current = next.scans[0].id;
          await load(next.scans[0].id, next);
          notify("Scan ready to explore");
        }
      } catch (e) {
        if (live) setFailure((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(toastTimer.current);
    };
  }, []);
  function changeReview(update: Review | ((previous: Review) => Review)) {
    const next = normalizeReview(
      typeof update === "function" ? update(reviewRef.current) : update,
    );
    reviewRef.current = next;
    reviewCache.current.set(scan.id, next);
    setReview(next);
    if (isSample) return;
    const scanId = scan.id;
    reviewWrites.current = reviewWrites.current
      .then(async () => {
        await api("review", { scanId, ...next });
        reviewSaveError.current = "";
      })
      .catch((e) => {
        reviewSaveError.current = e.message;
        notify("Review could not be saved: " + e.message);
      });
  }
  function toggle(f: Finding) {
    changeReview((previous) =>
      dispositionReview(
        previous,
        [f.id],
        previous.selected.includes(f.id) ? "removeReview" : "review",
      ),
    );
  }
  function changeDisposition(ids: string[], action: DispositionAction) {
    if (!ids.length) return;
    changeReview((previous) => dispositionReview(previous, ids, action));
    notify(
      action === "resolve"
        ? `${ids.length === 1 ? "Finding" : ids.length + " findings"} marked resolved`
        : action === "reopen"
          ? "Reopened for review"
          : action === "dismiss"
            ? "Finding dismissed"
            : "Review updated",
    );
  }
  const visible = useMemo(
    () =>
      scan.findings.filter(
        (f) =>
          !review.ignored.includes(f.id) && !review.resolved.includes(f.id),
      ),
    [scan, review.ignored, review.resolved],
  );
  const total = useMemo(
    () =>
      queueBytes(
        scan,
        visible.map((f) => f.id),
      ),
    [scan, visible],
  );
  const selectedTotal = useMemo(
    () => queueBytes(scan, review.selected),
    [scan, review.selected],
  );
  const lowTotal = useMemo(
    () =>
      queueBytes(
        scan,
        visible.filter((f) => f.risk === "low").map((f) => f.id),
      ),
    [scan, visible],
  );
  const filtered = useMemo(
    () =>
      scan.findings
        .filter(
          (f) =>
            (view !== "Review queue" || review.selected.includes(f.id)) &&
            (disposition === "all" ||
              (disposition === "resolved"
                ? review.resolved.includes(f.id)
                : disposition === "dismissed"
                  ? review.ignored.includes(f.id)
                  : !review.resolved.includes(f.id) &&
                    !review.ignored.includes(f.id))) &&
            (category === "all" || f.category === category) &&
            (risk === "all" || f.risk === risk) &&
            `${f.title} ${f.path} ${f.reason}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "size"
            ? b.bytes - a.bytes
            : sort === "name"
              ? a.path.localeCompare(b.path)
              : b.score - a.score,
        ),
    [scan, view, review, disposition, category, risk, query, sort],
  );
  const breakdown = useMemo(
    () => categorySizes(scan, visible),
    [scan, visible],
  );
  const catTotals = Object.entries(categories)
    .map(([key, c]) => ({ ...c, key, bytes: breakdown[key] || 0 }))
    .filter((c) => c.bytes > 0);
  async function reveal(target: string) {
    if (isSample) {
      notify("Scan a real folder to open its location.");
      return;
    }
    try {
      await api("reveal", { scanId: scan.id, path: target });
      notify("Folder requested in your file manager");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Path copied");
    } catch {
      notify("Clipboard unavailable. Select and copy the path in the details.");
    }
  }
  async function exportReport(format: "csv" | "json") {
    if (!isSample) {
      let pending;
      do {
        pending = reviewWrites.current;
        await pending;
      } while (pending !== reviewWrites.current);
      if (reviewSaveError.current) {
        notify(
          "Report export paused: review changes could not be saved. " +
            reviewSaveError.current,
        );
        return;
      }
      const a = document.createElement("a");
      a.href = `/api/scans/${scan.id}/report.${format}`;
      a.download = `reclaim-report.${format}`;
      a.click();
    } else {
      const text =
        format === "json"
          ? JSON.stringify({ sample: true, scan, review }, null, 2)
          : "Title,Category,Estimated bytes\r\n" +
            scan.findings
              .map((f) => `"${f.title}",${f.category},${f.bytes}`)
              .join("\r\n");
      const url = URL.createObjectURL(
        new Blob([text], {
          type: format === "json" ? "application/json" : "text/csv",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `reclaim-sample.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setReportOpen(false);
    notify("Report exported");
  }
  function navigate(v: View) {
    setView(v);
    setQuery("");
    setCategory("all");
    setRisk("all");
    setDisposition("open");
  }
  const table = (items: Finding[]) => (
    <OpportunityTable
      items={items}
      review={review}
      toggle={toggle}
      onInspect={setDetail}
      onDisposition={changeDisposition}
      emptyQueue={view === "Review queue"}
      emptyDone={
        view === "Overview" &&
        visible.length === 0 &&
        review.resolved.length > 0
      }
      onReset={() => {
        if (view === "Review queue" || view === "Overview") {
          navigate("Opportunities");
          if (review.resolved.length) setDisposition("resolved");
        } else {
          setQuery("");
          setCategory("all");
          setRisk("all");
          setDisposition("all");
        }
      }}
    />
  );
  const mapItems = useMemo(() => {
    const sep = scan.root.includes("\\") ? "\\" : "/";
    const prefix = mapPath.endsWith(sep) ? mapPath : mapPath + sep;
    const dirs = scan.directories.filter(
      (d) =>
        d.path.startsWith(prefix) && !d.path.slice(prefix.length).includes(sep),
    );
    const directFiles = scan.files
      .filter((f) => parent(f.path) === mapPath)
      .map((f) => ({ path: f.path, bytes: f.size }));
    const all = [...dirs, ...directFiles]
      .filter((i) => i.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
    if (!all.length && isSample)
      return scan.directories.filter(
        (d) => d.path.startsWith(prefix) && d.path !== mapPath,
      );
    return all;
  }, [scan, mapPath, isSample]);
  function mapChoose(p: string) {
    if (scan.directories.some((d) => d.path === p)) {
      setMapPath(p);
    } else {
      const f = scan.findings.find(
        (f) => f.path === p || f.filePaths.includes(p),
      );
      if (f) setDetail(f);
      else void reveal(p);
    }
  }
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
              ...(!scan.folderSizing
                ? ([
                    ["Overview", LayoutDashboard],
                    ["Opportunities", Sparkles],
                    ["Development", FolderGit2],
                    ["Space map", Map],
                    ["Duplicates", Copy],
                  ] as const)
                : []),
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
              {label === "Opportunities" && <b>{visible.length}</b>}
            </button>
          ))}
        </nav>
        <div className="rail-note">
          <div className="orb">
            <HardDrive size={22} />
          </div>
          {scan.disk ? (
            <>
              <strong>{bytes(scan.disk.free)} free</strong>
              <p>
                {bytes(scan.disk.total)} drive capacity
                <br />
                Snapshot at last scan
              </p>
              <div
                className="drive-meter"
                role="meter"
                aria-label="Available drive space at scan"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  (scan.disk.free / scan.disk.total) * 100,
                )}
                aria-valuetext={`${bytes(scan.disk.free)} available of ${bytes(scan.disk.total)}`}
              >
                <span
                  style={{
                    width: `${(scan.disk.free / scan.disk.total) * 100}%`,
                  }}
                />
              </div>
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
          <button onClick={() => setScanOpen(true)}>
            Scan a folder <Plus size={15} />
          </button>
        </div>
        <div className="rail-bottom">
          {!scan.folderSizing && (
            <button
              title="Review queue"
              className={view === "Review queue" ? "active" : ""}
              onClick={() => navigate("Review queue")}
            >
              <CheckCheck size={18} />
              Review queue <b>{review.selected.length}</b>
            </button>
          )}
          <button
            aria-label="Scan settings"
            className={view === "Settings" ? "active" : ""}
            onClick={() => navigate("Settings")}
          >
            <Settings2 size={18} />
            Settings
          </button>
          <div className="local-status">
            <span /> Local & private <span className="version">v1.0</span>
          </div>
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
              onClick={() => setScanOpen(true)}
              disabled={
                !state ||
                !!state.job ||
                state.cleanupBusy ||
                !!state.measurementJob
              }
            >
              <Plus size={16} />
              New scan
            </button>
          </div>
        </header>
        <main>
          {failure && (
            <div className="alert error">
              <TriangleAlert size={18} />
              {failure} Start the local service with npm start, then reload.
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
          {state?.measurementJob && (
            <div className="scan-progress" role="status">
              <LoaderCircle className="spin" size={20} />
              <div>
                <strong>
                  Measuring potential gain · {state.measurementJob.done}/
                  {state.measurementJob.total} folders checked
                </strong>
                <small>{state.measurementJob.path}</small>
              </div>
              <button
                className="secondary small"
                onClick={() =>
                  void api("measurements/cancel", {}).catch((e) =>
                    notify(e.message),
                  )
                }
              >
                <Square size={13} />
                Cancel measurements
              </button>
            </div>
          )}
          {state?.lastError && (
            <div className="alert error">
              <TriangleAlert size={18} />
              Last scan failed: {state.lastError}
            </div>
          )}
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                {isSample
                  ? "EXPLORE A SAMPLE WORKSPACE"
                  : `FOLDER SCAN · ${date(scan.completedAt)}`}
              </div>
              <h1>{view === "Overview" ? "Your space, explained." : view}</h1>
              <p>
                {
                  {
                    Overview:
                      "A closer look at what’s on your disk, and what you could reclaim.",
                    Opportunities:
                      "Useful leads, ranked by potential savings and how easy they are to rebuild.",
                    "Space map":
                      "Follow the space. Explore folders from the biggest down.",
                    Folders:
                      "Every folder above your size threshold, across the selected search area.",
                    Duplicates:
                      "Identical contents, different locations. Keep the copies you need.",
                    History: "See how your storage changes over time.",
                    Settings: "Make every scan work the way you do.",
                    Development:
                      "Make room between projects. Keep the source, understand the rebuild.",
                    "Review queue":
                      "A considered shortlist. Review the impact before taking action.",
                  }[view]
                }
              </p>
            </div>
            <div className="heading-actions">
              {isSample && <span className="sample-badge">Sample data</span>}
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
                    <button onClick={() => exportReport("csv")}>
                      Spreadsheet (.csv)
                    </button>
                    <button onClick={() => exportReport("json")}>
                      Full report (.json)
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
          {isSample && (
            <div className="sample-strip">
              <Info size={16} />
              <span>
                This is an illustrative workspace. Scan a folder to see your own
                files.
              </span>
              <button onClick={() => setScanOpen(true)}>
                Scan my files <ArrowRight size={15} />
              </button>
            </div>
          )}
          {!isSample && scan.status !== "completed" && (
            <div className="alert">
              <TriangleAlert size={18} />
              {scan.status === "cancelled"
                ? "This scan was stopped. Results cover only the files scanned."
                : "This scan is partial. Some paths could not be analyzed."}
              <button onClick={() => setCoverage(true)}>View coverage</button>
            </div>
          )}
          {(view === "Folders" ||
            (view === "Overview" && scan.folderSizing)) && (
            <LargeFolders
              key={scan.id}
              scan={scan}
              onFindIgnored={
                isSample
                  ? undefined
                  : (minimumBytes) =>
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
              onPrepare={isSample ? undefined : setCleanupRequest}
              changedSinceScan={changedSinceScan}
              onScan={(minimumBytes) => {
                setScanPreset({
                  root: scan.root,
                  operation: "folder-sizes",
                  folderMinBytes: minimumBytes,
                });
                setScanOpen(true);
              }}
            />
          )}
          {view === "Overview" && !scan.folderSizing && (
            <>
              <section className="overview-hero">
                <div className="savings-summary">
                  <span className="section-kicker">
                    <Sparkles size={16} />
                    ROOM TO RECLAIM
                  </span>
                  <div className="hero-number">
                    {bytes(total).split(" ")[0]}
                    <span>{bytes(total).split(" ")[1]}</span>
                  </div>
                  <h2>worth a closer look</h2>
                  <p>
                    Across {visible.length}{" "}
                    {visible.length === 1 ? "opportunity" : "opportunities"} in{" "}
                    <strong>{scan.name}</strong>.
                  </p>
                  <button
                    className="primary"
                    onClick={() => navigate("Opportunities")}
                  >
                    Explore opportunities <ArrowRight size={17} />
                  </button>
                  <small>
                    <Info size={12} /> Estimated logical size. Actual disk
                    savings may differ.
                  </small>
                </div>
                <div className="storage-landscape">
                  <div className="landscape-title">
                    <span>
                      <Folder size={16} />
                      {scan.name}
                    </span>
                    <span>{bytes(scan.totalBytes)} analyzed</span>
                  </div>
                  <Treemap
                    compact
                    items={catTotals
                      .map((c) => ({
                        path: c.key,
                        label: c.label,
                        bytes: c.bytes,
                        color: c.color,
                        opportunity: true,
                      }))
                      .concat([
                        {
                          path: "other",
                          label: "Other files",
                          bytes: Math.max(0, scan.totalBytes - total),
                          color: "#becbdb",
                          opportunity: false,
                        },
                      ])}
                    onChoose={(p) => {
                      if (p === "other") {
                        navigate("Space map");
                      } else {
                        navigate("Opportunities");
                        setCategory(p);
                      }
                    }}
                  />
                  <div className="landscape-legend">
                    <span>
                      <i className="hatched" />
                      Potential opportunities{" "}
                      <b>
                        {scan.totalBytes
                          ? Math.round((total / scan.totalBytes) * 100)
                          : 0}
                        %
                      </b>
                    </span>
                    <button onClick={() => navigate("Space map")}>
                      Open space map <ArrowUpRight size={15} />
                    </button>
                  </div>
                </div>
              </section>
              <section className="stat-strip">
                <div>
                  <span className="stat-icon sea">
                    <ShieldCheck size={20} />
                  </span>
                  <span>
                    <b>{bytes(lowTotal)}</b>
                    <small>Rebuildable files</small>
                  </span>
                </div>
                <div>
                  <span className="stat-icon blue">
                    <Files size={20} />
                  </span>
                  <span>
                    <b>{scan.fileCount.toLocaleString()}</b>
                    <small>Files analyzed</small>
                  </span>
                </div>
                <div>
                  <span className="stat-icon purple">
                    <Copy size={20} />
                  </span>
                  <span>
                    <b>{scan.duplicateGroups.length}</b>
                    <small>Verified duplicate groups</small>
                  </span>
                </div>
                <div>
                  <span className="stat-icon slate">
                    <Clock3 size={20} />
                  </span>
                  <span>
                    <b>{(scan.durationMs / 1000).toFixed(1)} sec</b>
                    <button onClick={() => setCoverage(true)}>
                      Scan coverage <ChevronRight size={12} />
                    </button>
                  </span>
                </div>
              </section>
              <section className="content-grid">
                <div className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Start here</h2>
                      <p>Your highest-ranked opportunities</p>
                    </div>
                    <button
                      className="text-btn"
                      onClick={() => navigate("Opportunities")}
                    >
                      View all <ArrowRight size={15} />
                    </button>
                  </div>
                  {table(visible.slice(0, 5))}
                </div>
                <aside className="insight-panel">
                  <span className="section-kicker">
                    <ShieldCheck size={16} /> A THOUGHTFUL CLEANUP
                  </span>
                  <h2>
                    Less guesswork.
                    <br />
                    More breathing room.
                  </h2>
                  <p>
                    Start with files your applications can rebuild. Take a
                    closer look at everything else.
                  </p>
                  <div className="insight-row">
                    <CheckCircle2 size={17} />
                    <span>Every finding explains why</span>
                  </div>
                  <div className="insight-row">
                    <CheckCircle2 size={17} />
                    <span>Your files stay untouched</span>
                  </div>
                  <div className="insight-row">
                    <CheckCircle2 size={17} />
                    <span>You decide what to keep</span>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => {
                      navigate("Opportunities");
                      setRisk("low");
                    }}
                  >
                    See rebuildable files <ArrowRight size={16} />
                  </button>
                </aside>
              </section>
              <div className="scan-footnote">
                <FolderOpen size={14} />
                <span title={scan.root}>{scan.root}</span>
                <button
                  onClick={() => void copy(scan.root)}
                  aria-label="Copy scan folder"
                >
                  <Copy size={13} />
                </button>
                <span className="dot-separator">·</span>
                <span>
                  {scan.skipped.length} skipped{" "}
                  {scan.skipped.length === 1 ? "path" : "paths"} ·{" "}
                  {scan.errors.length}{" "}
                  {scan.errors.length === 1 ? "error" : "errors"}
                </span>
                <button className="text-btn" onClick={() => setCoverage(true)}>
                  Details
                </button>
              </div>
            </>
          )}
          {(view === "Opportunities" || view === "Review queue") && (
            <>
              {view === "Review queue" && (
                <div className="queue-banner">
                  <CheckCheck size={23} />
                  <div>
                    <strong>
                      {review.selected.length} selected · {bytes(selectedTotal)}
                    </strong>
                    <p>
                      Logical bytes, with overlapping files counted once. Keep a
                      duplicate copy in a needed location.
                    </p>
                  </div>
                  <button
                    className="primary"
                    disabled={!review.selected.length}
                    onClick={() =>
                      changeDisposition(reviewRef.current.selected, "resolve")
                    }
                  >
                    <CheckCircle2 size={16} />
                    Mark selected resolved
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void changeReview({ ...review, selected: [] })
                    }
                  >
                    Clear queue
                  </button>
                </div>
              )}
              <section className="panel">
                {view !== "Review queue" && (
                  <div
                    className="disposition-tabs"
                    role="group"
                    aria-label="Finding disposition"
                  >
                    {[
                      ["open", "Active", visible.length],
                      ["resolved", "Resolved", review.resolved.length],
                      ["dismissed", "Dismissed", review.ignored.length],
                      ["all", "All", scan.findings.length],
                    ].map(([value, label, count]) => (
                      <button
                        key={value}
                        className={disposition === value ? "chosen" : ""}
                        aria-pressed={disposition === value}
                        onClick={() => setDisposition(String(value))}
                      >
                        {label}
                        <b>{count}</b>
                      </button>
                    ))}
                  </div>
                )}
                {disposition === "resolved" && (
                  <div className="resolved-note">
                    <CheckCircle2 size={16} />
                    <span>
                      Marked done for this scan. Reopen an item if it needs
                      attention; new scans check the files again.
                    </span>
                  </div>
                )}
                <div className="filters">
                  <label className="search-field">
                    <Search size={17} />
                    <input
                      placeholder="Search files, folders, or reasons…"
                      aria-label="Search opportunities"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    <option value="all">All types</option>
                    {Object.entries(categories).map(([k, v]) => (
                      <option value={k} key={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Impact"
                    value={risk}
                    onChange={(e) => setRisk(e.target.value)}
                  >
                    <option value="all">All impacts</option>
                    <option value="low">Rebuildable</option>
                    <option value="review">Review first</option>
                  </select>
                  <select
                    aria-label="Sort opportunities"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="priority">Recommended</option>
                    <option value="size">Largest first</option>
                    <option value="name">Path A–Z</option>
                  </select>
                </div>
                <div className="list-meta">
                  <span>
                    {filtered.length}{" "}
                    {filtered.length === 1 ? "opportunity" : "opportunities"}{" "}
                    <i>·</i>{" "}
                    {bytes(
                      queueBytes(
                        scan,
                        filtered.map((f) => f.id),
                      ),
                    )}
                  </span>
                  <span>Dispositions are saved with this scan</span>
                </div>
                {table(filtered)}
                <div className="table-footer">
                  <button
                    className="text-btn"
                    onClick={() =>
                      void changeReview((previous) =>
                        dispositionReview(
                          previous,
                          filtered.map((f) => f.id),
                          "review",
                        ),
                      )
                    }
                  >
                    <Plus size={14} /> Add visible to review
                  </button>
                  {disposition === "resolved" ? (
                    <button
                      className="text-btn"
                      disabled={!filtered.length}
                      onClick={() =>
                        changeDisposition(
                          filtered.map((f) => f.id),
                          "reopen",
                        )
                      }
                    >
                      Reopen visible
                    </button>
                  ) : (
                    review.selected.length > 0 && (
                      <button
                        className="text-btn"
                        onClick={() =>
                          changeDisposition(
                            reviewRef.current.selected,
                            "resolve",
                          )
                        }
                      >
                        <CheckCircle2 size={14} />
                        Mark selected resolved ({review.selected.length})
                      </button>
                    )
                  )}
                  <span>Estimates use logical file sizes</span>
                </div>
              </section>
            </>
          )}
          {view === "Space map" && (
            <section className="panel map-panel">
              <div className="panel-heading">
                <div>
                  <h2>{basename(mapPath)}</h2>
                  <p className="path-text">{mapPath}</p>
                </div>
                <div className="flex">
                  <button
                    className="secondary small"
                    disabled={mapPath === scan.root}
                    onClick={() => setMapPath(parent(mapPath))}
                  >
                    <ArrowLeft size={14} />
                    Up one level
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => setMapPath(scan.root)}
                    aria-label="Reset map"
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>
              {mapItems.length ? (
                <Treemap items={mapItems} onChoose={mapChoose} />
              ) : (
                <div className="empty">
                  <FolderOpen size={32} />
                  <h3>No files at this level</h3>
                  <p>Choose a different folder or go up one level.</p>
                </div>
              )}
              <div className="folder-list">
                {mapItems.slice(0, 32).map((d, i) => (
                  <button key={d.path} onClick={() => mapChoose(d.path)}>
                    <span>
                      <i
                        style={{
                          background: [
                            "#4678de",
                            "#279b94",
                            "#8b78bc",
                            "#d8a155",
                          ][i % 4],
                        }}
                      />
                      {basename(d.path)}
                    </span>
                    <b>{bytes(d.bytes)}</b>
                    <div className="folder-bar">
                      <i
                        style={{
                          width:
                            Math.max(
                              1,
                              (d.bytes / (mapItems[0]?.bytes || 1)) * 100,
                            ) + "%",
                        }}
                      />
                    </div>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
              <div className="table-footer">
                <span>
                  Largest 32 entries per level · folders include their contents
                </span>
                <span>Click a folder to explore</span>
              </div>
            </section>
          )}
          {view === "Duplicates" && (
            <>
              <div className="duplicates-summary">
                <span className="stat-icon purple">
                  <Copy size={26} />
                </span>
                <div>
                  <h2>
                    {bytes(
                      scan.duplicateGroups.reduce((n, g) => n + g.bytes, 0),
                    )}{" "}
                    in extra copies
                  </h2>
                  <p>
                    {scan.duplicateGroups.length}{" "}
                    {scan.duplicateGroups.length === 1 ? "group" : "groups"}{" "}
                    verified by full SHA-256 hashes. One suggested keeper per
                    group.
                  </p>
                </div>
              </div>
              {!scan.options.duplicates && !isSample && (
                <div className="alert">
                  <Info size={18} />
                  <span>
                    Duplicate verification was off for this scan. Enable it in a
                    new scan to compare file contents.
                  </span>
                  <button onClick={() => setScanOpen(true)}>New scan</button>
                </div>
              )}
              {scan.duplicateGroups.map((g) => (
                <section className="panel duplicate-card" key={g.id}>
                  <div className="panel-heading">
                    <div>
                      <h2>{basename(g.files[0].path)}</h2>
                      <p>
                        {g.files.length} copies · {bytes(g.files[0].size)} each
                      </p>
                    </div>
                    <span className="duplicate-saving">
                      {bytes(g.bytes)} extra
                    </span>
                  </div>
                  {g.files.map((f, i) => (
                    <div className="duplicate-file" key={f.path}>
                      <Files size={18} />
                      <span>{f.path}</span>
                      {i === 0 ? (
                        <span className="keeper">
                          <Check size={12} />
                          Suggested keeper
                        </span>
                      ) : (
                        <span className="extra-copy">Extra copy</span>
                      )}
                      <button
                        className="icon-btn"
                        aria-label={`Open ${f.path}`}
                        onClick={() => void reveal(f.path)}
                      >
                        <ExternalLink size={15} />
                      </button>
                    </div>
                  ))}
                  <div className="hash-line">
                    SHA-256 <code>{g.hash}</code>
                    <button
                      className="text-btn"
                      onClick={() => {
                        const f = scan.findings.find(
                          (f) =>
                            f.evidence.some((e) => e.includes(g.hash)) ||
                            (isSample && f.category === "duplicates"),
                        );
                        if (f) setDetail(f);
                      }}
                    >
                      Review finding <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
              ))}
              {!scan.duplicateGroups.length && (
                <div className="panel empty">
                  <Copy size={36} />
                  <h3>No verified duplicates in this scan</h3>
                  <p>
                    {scan.options.duplicates
                      ? "Files below the duplicate threshold, over the hash budget, or skipped paths were not compared."
                      : "Start a scan with duplicate verification to compare full file contents."}
                  </p>
                  <button className="primary" onClick={() => setScanOpen(true)}>
                    Scan a folder
                  </button>
                </div>
              )}
              {scan.notices.map((n) => (
                <div className="alert" key={n}>
                  <Info size={17} />
                  {n}
                </div>
              ))}
            </>
          )}
          {view === "History" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Your scan timeline</h2>
                  <p>Reports are saved on this computer.</p>
                </div>
                <button
                  className="secondary small"
                  onClick={() => {
                    setScan(sample);
                    setMapPath(sample.root);
                    reviewRef.current = normalizeReview();
                    setReview(reviewRef.current);
                    navigate("Overview");
                  }}
                >
                  Explore sample
                </button>
              </div>
              {state?.scans.length ? (
                state.scans.map((s, i) => {
                  const previous = state.scans
                    .slice(i + 1)
                    .find((old) => old.root === s.root);
                  const delta = previous ? scanDelta(s, previous) : null;
                  return (
                    <button
                      className="history-row"
                      key={s.id}
                      onClick={() => {
                        void load(s.id).then(() =>
                          navigate(
                            s.operation === "folder-sizes"
                              ? "Folders"
                              : "Overview",
                          ),
                        );
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
                        <b>
                          {s.operation === "folder-sizes" ? (
                            "Folder totals"
                          ) : (
                            <>
                              {s.findingCount}{" "}
                              {s.findingCount === 1
                                ? "opportunity"
                                : "opportunities"}
                            </>
                          )}
                        </b>
                        <small>
                          {s.operation === "folder-sizes" ? (
                            "Recursive logical size"
                          ) : (
                            <>{bytes(s.opportunityBytes)} estimated</>
                          )}
                        </small>
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
                  <button className="primary" onClick={() => setScanOpen(true)}>
                    Start first scan
                  </button>
                </div>
              )}
            </section>
          )}
          {view === "Development" && (
            <Development
              onSettingsSaved={setSettings}
              request={discoveryRequest}
              onReset={() => setDiscoveryRequest({})}
              api={api}
              settings={settings}
              findings={isSample ? [] : scan.findings}
              records={state?.cleanups || []}
              onPrepare={setCleanupRequest}
              onSettings={() => navigate("Settings")}
            />
          )}
          {view === "Settings" && (
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
              <section className="panel settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Finding opportunities</h2>
                    <p>These defaults apply to your next scan.</p>
                  </div>
                  <SlidersHorizontal size={20} />
                </div>
                <div className="settings-body">
                  <div className="setting-field">
                    <label htmlFor="minimum">Minimum opportunity size</label>
                    <select
                      id="minimum"
                      value={settings.minimumBytes}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          minimumBytes: +e.target.value,
                        })
                      }
                    >
                      {[1, 10, 50, 100, 500].map((n) => (
                        <option key={n} value={n * 1024 ** 2}>
                          {n} MB
                        </option>
                      ))}
                    </select>
                    <small>
                      Keep the results focused on meaningful savings.
                    </small>
                  </div>
                  <div className="setting-field">
                    <label htmlFor="stale">Consider files older than</label>
                    <select
                      id="stale"
                      value={settings.staleDays}
                      onChange={(e) =>
                        setSettings({ ...settings, staleDays: +e.target.value })
                      }
                    >
                      {[30, 60, 90, 120, 180, 365].map((n) => (
                        <option key={n} value={n}>
                          {n} days
                        </option>
                      ))}
                    </select>
                    <small>
                      Based on modification time, which does not show when you
                      last opened a file.
                    </small>
                  </div>
                  <div className="setting-field">
                    <label htmlFor="large">Large file threshold</label>
                    <select
                      id="large"
                      value={settings.largeFileBytes}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          largeFileBytes: +e.target.value,
                        })
                      }
                    >
                      {[50, 100, 250, 500, 1024].map((n) => (
                        <option key={n} value={n * 1024 ** 2}>
                          {n === 1024 ? "1 GB" : n + " MB"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="switch-row">
                    <div>
                      <strong>Verify duplicate files</strong>
                      <small>
                        Reads complete contents of same-size candidates. This
                        takes longer.
                      </small>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.duplicates}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          duplicates: e.target.checked,
                        })
                      }
                    />
                  </label>
                  <div className="setting-field">
                    <label htmlFor="budget">Duplicate read budget</label>
                    <select
                      id="budget"
                      value={settings.hashBudgetBytes}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          hashBudgetBytes: +e.target.value,
                        })
                      }
                    >
                      {[1, 5, 10, 25].map((n) => (
                        <option key={n} value={n * 1024 ** 3}>
                          {n} GB
                        </option>
                      ))}
                    </select>
                    <small>
                      Limits how much data one scan reads to verify duplicates.
                    </small>
                  </div>
                  <div className="setting-field">
                    <label htmlFor="duplicate-minimum">
                      Compare files at least
                    </label>
                    <select
                      id="duplicate-minimum"
                      value={settings.duplicateMinBytes}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          duplicateMinBytes: +e.target.value,
                        })
                      }
                    >
                      {[
                        64 * 1024,
                        256 * 1024,
                        1024 ** 2,
                        5 * 1024 ** 2,
                        10 * 1024 ** 2,
                      ].map((n) => (
                        <option key={n} value={n}>
                          {bytes(n)}
                        </option>
                      ))}
                    </select>
                    <small>
                      Smaller candidates increase the number of content
                      comparisons.
                    </small>
                  </div>
                  <div className="setting-field">
                    <label htmlFor="file-limit">
                      Maximum files per legacy full scan
                    </label>
                    <select
                      id="file-limit"
                      value={settings.maxFiles}
                      onChange={(e) =>
                        setSettings({ ...settings, maxFiles: +e.target.value })
                      }
                    >
                      {[25000, 100000, 250000, 500000, 1000000].map((n) => (
                        <option key={n} value={n}>
                          {n.toLocaleString()}
                        </option>
                      ))}
                    </select>
                    <small>
                      Only legacy full scans use this limit. Folder totals scans
                      have no file or directory cap.
                    </small>
                  </div>
                </div>
              </section>
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
                      files are skipped automatically. Legacy full scans have a{" "}
                      {settings.maxFiles.toLocaleString()} file limit. Folder
                      totals scans have no file or directory cap.
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
      {review.selected.length > 0 && view !== "Review queue" && (
        <button
          className="floating-queue"
          onClick={() => navigate("Review queue")}
        >
          <CheckCheck size={18} />
          <span>
            {review.selected.length} in review <b>{bytes(selectedTotal)}</b>
          </span>
          <ArrowRight size={16} />
        </button>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {scanOpen && (
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
      {detail && (
        <FindingDrawer
          detail={detail}
          review={review}
          onClose={() => setDetail(null)}
          reveal={reveal}
          copy={copy}
          toggle={toggle}
          onDisposition={changeDisposition}
          onCleanup={
            !isSample && ["builds", "dependencies"].includes(detail.category)
              ? () =>
                  setCleanupRequest({ scanId: scan.id, findingId: detail.id })
              : undefined
          }
        />
      )}
      {coverage && (
        <CoverageDialog scan={scan} onClose={() => setCoverage(false)} />
      )}
      {cleanupRequest && (
        <CleanupDialog
          request={cleanupRequest}
          api={api}
          onClose={() => setCleanupRequest(null)}
          onDone={(result) => {
            void api("state")
              .then((next: State) => {
                setState(next);
                if (result.status === "deleted" && result.scanId === scan.id) {
                  const refreshed = normalizeReview(next.reviews[scan.id]);
                  reviewRef.current = refreshed;
                  reviewCache.current.set(scan.id, refreshed);
                  setReview(refreshed);
                }
              })
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
