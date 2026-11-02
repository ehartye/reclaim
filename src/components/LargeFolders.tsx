import { useMemo, useRef, useState } from "react";
import {
  Folder,
  Search,
  ArrowUpRight,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Files,
  LoaderCircle,
} from "lucide-react";
import { basename, parent } from "../types";
import type { Scan, Directory, FolderInspection } from "../types";
import type { IgnoredFolderResult } from "../types";
import { IgnoredFolders } from "./IgnoredFolders";
import { folderBytes } from "../folder-format";
function savedIgnoredPreference(): { active: boolean; minimum: number } | null {
  try {
    const value = JSON.parse(
      localStorage.getItem("reclaim.ignored-folders") || "null",
    );
    return value &&
      Number.isFinite(value.minimum) &&
      value.minimum >= 0 &&
      value.minimum <= 1024 ** 5 / 1000000
      ? { active: value.active === true, minimum: value.minimum }
      : null;
  } catch {
    return null;
  }
}
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const pageSize = 50;
const categoryNames: Record<string, string[]> = {
  builds: [
    "intermediate",
    "build",
    "dist",
    "out",
    "target",
    "bin",
    "obj",
    ".next",
    ".nuxt",
    "coverage",
    "library",
    ".godot",
  ],
  dependencies: ["node_modules", ".venv", "venv", "vendor"],
  caches: [
    ".cache",
    "cache",
    "caches",
    ".gradle",
    ".npm",
    "__pycache__",
    ".nuget",
    ".m2",
    ".pnpm-store",
    ".yarn",
    "_cacache",
    ".turbo",
    ".ruff_cache",
    ".pytest_cache",
    "deriveddatacache",
  ],
};
export function LargeFolders({
  scan,
  onScan,
  onReveal,
  onInspect,
  onPrepare,
  onFindIgnored,
  changedSinceScan = false,
}: {
  scan: Scan;
  onScan: (minimumBytes: number) => void;
  onReveal: (path: string) => void;
  onInspect: (path: string, offset?: number) => Promise<FolderInspection>;
  onPrepare?: (request: { scanId: string; directoryPath: string }) => void;
  onFindIgnored?: (minimumBytes: number) => Promise<IgnoredFolderResult>;
  changedSinceScan?: boolean;
}) {
  const [preference] = useState(savedIgnoredPreference);
  const [minimum, setMinimum] = useState(
      preference?.active
        ? preference.minimum
        : (scan.folderSizing?.minimumBytes ?? 500000000) / 1000000,
    ),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(
      preference?.active && onFindIgnored ? "ignored" : "all",
    ),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set()),
    [limits, setLimits] = useState<Record<string, number>>({}),
    [inspections, setInspections] = useState<Record<string, FolderInspection>>(
      {},
    ),
    [fileOpen, setFileOpen] = useState<Set<string>>(new Set()),
    [loading, setLoading] = useState<Set<string>>(new Set()),
    [errors, setErrors] = useState<Record<string, string>>({});
  const inspectionRevisions = useRef(new Map<string, number>());
  const valid =
    Number.isFinite(minimum) && minimum >= 0 && minimum <= 1024 ** 5 / 1000000;
  const filtering = !!query.trim() || category !== "all";
  const tree = useMemo(() => {
    const rows = new Map(scan.directories.map((d) => [d.path, d]));
    if (!rows.has(scan.root))
      rows.set(scan.root, {
        path: scan.root,
        bytes: scan.totalBytes,
        fileCount: scan.fileCount,
      });
    const worktreePaths = new Set(
      scan.directories.filter((d) => d.hasGitFile).map((d) => d.path),
    );
    const matches = new Set<string>(),
      included = new Set<string>([scan.root]);
    const childMap = new Map<string, Directory[]>();
    for (const d of rows.values()) {
      const relative =
        d.path === scan.root
          ? ""
          : d.path.slice(scan.root.replace(/[\\/]$/, "").length + 1);
      const segments = [
        basename(scan.root).toLowerCase(),
        ...relative.toLowerCase().split(/[\\/]/),
      ];
      let inWorktree = false;
      if (category === "worktrees") {
        let current = d.path;
        while (rows.has(current)) {
          if (worktreePaths.has(current)) {
            inWorktree = true;
            break;
          }
          const next = parent(current);
          if (next === current) break;
          current = next;
        }
      }
      const categoryMatch =
        category === "all" ||
        (category === "worktrees"
          ? inWorktree
          : segments.some((s) => categoryNames[category]?.includes(s)));
      if (
        valid &&
        d.bytes > minimum * 1000000 &&
        categoryMatch &&
        d.path.toLowerCase().includes(query.trim().toLowerCase())
      ) {
        matches.add(d.path);
        let p = d.path;
        while (rows.has(p) && !included.has(p)) {
          included.add(p);
          const next = parent(p);
          if (next === p) break;
          p = next;
        }
      }
    }
    for (const p of included) {
      if (p === scan.root) continue;
      const owner = parent(p),
        list = childMap.get(owner) || [];
      list.push(rows.get(p)!);
      childMap.set(owner, list);
    }
    for (const list of childMap.values())
      list.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    return { root: rows.get(scan.root)!, matches, childMap };
  }, [scan, minimum, query, category, valid]);
  async function inspect(path: string, offset = 0) {
    const revision = (inspectionRevisions.current.get(path) || 0) + 1;
    inspectionRevisions.current.set(path, revision);
    setFileOpen((s) => new Set(s).add(path));
    setLoading((s) => new Set(s).add(path));
    setErrors((s) => ({ ...s, [path]: "" }));
    try {
      const result = await onInspect(path, offset);
      if (inspectionRevisions.current.get(path) !== revision) return;
      setInspections((s) => ({
        ...s,
        [path]: {
          ...result,
          files: offset
            ? [...(s[path]?.files || []), ...result.files]
            : result.files,
        },
      }));
    } catch (e) {
      if (inspectionRevisions.current.get(path) !== revision) return;
      setErrors((s) => ({ ...s, [path]: (e as Error).message }));
    } finally {
      setLoading((s) => {
        if (inspectionRevisions.current.get(path) !== revision) return s;
        const n = new Set(s);
        n.delete(path);
        return n;
      });
    }
  }
  function renderFolder(d: Directory, depth: number): React.ReactNode {
    const name = basename(d.path),
      children = tree.childMap.get(d.path) || [],
      open =
        filtering && !tree.matches.has(d.path)
          ? !filterCollapsed.has(d.path)
          : expanded.has(d.path),
      limit = limits[d.path] || pageSize,
      result = inspections[d.path],
      filesVisible = fileOpen.has(d.path);
    return (
      <div className="folder-tree-branch" key={d.path}>
        <div
          className="folder-tree-row"
          style={{ "--tree-depth": Math.min(depth, 8) } as React.CSSProperties}
        >
          <div className="folder-tree-name">
            {children.length > 0 ? (
              <button
                className="icon-btn tree-toggle"
                aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
                aria-expanded={open}
                onClick={() => {
                  const update = (s: Set<string>) => {
                    const n = new Set(s);
                    if (n.has(d.path)) n.delete(d.path);
                    else n.add(d.path);
                    return n;
                  };
                  if (filtering && !tree.matches.has(d.path))
                    setFilterCollapsed(update);
                  else setExpanded(update);
                }}
              >
                {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
              </button>
            ) : (
              <span className="tree-toggle" />
            )}
            <Folder size={18} />
            <div className="large-folder-path">
              <strong>{name}</strong>
              {!tree.matches.has(d.path) && (
                <span className="folder-context">Ancestor</span>
              )}
              <code>{d.path}</code>
              <small>
                {d.fileCount.toLocaleString()} file entries · includes
                subfolders{d.estimated ? " · Estimated" : ""}
                {d.complete === false && !d.estimated ? " · Incomplete" : ""}
                {d.measuredAt ? ` · ${date(d.measuredAt)}` : ""}
              </small>
            </div>
          </div>
          <div
            className="large-folder-bytes"
            title={`${d.bytes.toLocaleString()} bytes`}
          >
            <strong>
              {d.estimated ? "≈ " : ""}
              {folderBytes(d.bytes)}
            </strong>
          </div>
          <div className="folder-row-actions">
            {onPrepare &&
              (d.hasGitFile ||
                categoryNames.builds.includes(name.toLowerCase()) ||
                categoryNames.dependencies.includes(name.toLowerCase())) && (
                <button
                  className="secondary small"
                  aria-label={`Review cleanup for ${name}`}
                  onClick={() =>
                    onPrepare({ scanId: scan.id, directoryPath: d.path })
                  }
                >
                  Review cleanup
                </button>
              )}
            <button
              className="secondary small"
              aria-label={`${filesVisible ? "Hide" : "Inspect"} files in ${name}`}
              onClick={() => {
                if (filesVisible)
                  setFileOpen((s) => {
                    const n = new Set(s);
                    n.delete(d.path);
                    return n;
                  });
                else if (result) setFileOpen((s) => new Set(s).add(d.path));
                else void inspect(d.path);
              }}
            >
              <Files size={14} />
              {filesVisible ? "Hide files" : "Inspect files"}
            </button>
            <button
              className="icon-btn"
              aria-label={`Open folder ${name}`}
              onClick={() => onReveal(d.path)}
            >
              <ArrowUpRight size={17} />
            </button>
          </div>
        </div>
        {filesVisible && (
          <div className="folder-file-list" aria-label={`Files in ${name}`}>
            <strong>Files in this branch · {name}</strong>
            <p>
              Live file metadata, including subfolders. Paths are relative to
              this branch.
            </p>
            {loading.has(d.path) && (
              <p role="status">
                <LoaderCircle size={15} className="spin" /> Loading file
                metadata…
              </p>
            )}
            {errors[d.path] && (
              <div className="alert error" role="alert">
                {errors[d.path]}
                <button
                  className="secondary small"
                  onClick={() => void inspect(d.path)}
                >
                  Retry
                </button>
              </div>
            )}
            {result?.notices.map((notice, i) => (
              <p key={i}>{notice}</p>
            ))}
            {result?.files.map((f) => (
              <div className="folder-file-row" key={f.path}>
                <code title={f.path}>
                  {f.path.slice(d.path.replace(/[\\/]$/, "").length + 1)}
                </code>
                <span>{folderBytes(f.size)}</span>
              </div>
            ))}
            {result && !result.files.length && !loading.has(d.path) && (
              <p>No accessible files in this branch.</p>
            )}
            {result?.nextOffset != null && (
              <button
                className="secondary small"
                disabled={loading.has(d.path)}
                onClick={() => void inspect(d.path, result.nextOffset!)}
              >
                Show more files
              </button>
            )}
          </div>
        )}
        {open &&
          children
            .slice(0, limit)
            .map((child) => renderFolder(child, depth + 1))}
        {open && children.length > limit && (
          <div className="folder-tree-more">
            <button
              className="secondary small"
              onClick={() =>
                setLimits((s) => ({ ...s, [d.path]: limit + pageSize }))
              }
            >
              Show {Math.min(pageSize, children.length - limit)} more folders in{" "}
              {name}
            </button>
            <span>
              {limit} of {children.length} direct subfolders
            </span>
          </div>
        )}
      </div>
    );
  }
  return (
    <section className="panel folder-size-results">
      <div className="panel-heading">
        <div>
          <h2>Follow the space, folder by folder</h2>
          <p>
            Expand a branch to explore its totals. Inspect files only when
            needed.
          </p>
        </div>
        <button
          className="primary small"
          onClick={() =>
            onScan(valid ? Math.round(minimum * 1000000) : 500000000)
          }
        >
          <RefreshCw size={15} />
          Scan folder totals
        </button>
      </div>
      {changedSinceScan && (
        <div className="alert">
          <span>
            <strong>Cleanup changed this search area after the scan.</strong>{" "}
            Saved folder totals are a snapshot from before cleanup. Run another
            scan for current sizes.
          </span>
        </div>
      )}
      <div className="folder-scope">
        <Folder size={18} />
        <code>{scan.root}</code>
        <span>
          {scan.folderSizing
            ? "Folder totals scan"
            : "Recorded full-scan totals"}
        </span>
      </div>
      <div className="folder-total-controls">
        <label>
          Folder total greater than
          <div className="folder-threshold">
            <input
              aria-label="Folder total greater than"
              type="number"
              min="0"
              max={1024 ** 5 / 1000000}
              step="any"
              value={Number.isNaN(minimum) ? "" : minimum}
              onChange={(e) => {
                setMinimum(e.target.valueAsNumber);
                if (category === "ignored") {
                  try {
                    localStorage.setItem(
                      "reclaim.ignored-folders",
                      JSON.stringify({
                        active: true,
                        minimum: e.target.valueAsNumber,
                      }),
                    );
                  } catch {}
                }
                setLimits({});
              }}
            />
            <span>MB</span>
          </div>
        </label>
        <label>
          Search folder paths
          <div className="path-input">
            <Search size={17} />
            <input
              aria-label="Search folder paths"
              value={query}
              placeholder="Filter by folder or path"
              onChange={(e) => {
                setQuery(e.target.value);
                setLimits({});
                setFilterCollapsed(new Set());
              }}
            />
          </div>
        </label>
        <label>
          Folder category
          <select
            aria-label="Folder category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              try {
                localStorage.setItem(
                  "reclaim.ignored-folders",
                  JSON.stringify({
                    active: e.target.value === "ignored",
                    minimum,
                  }),
                );
              } catch {}
              setLimits({});
              setFilterCollapsed(new Set());
            }}
          >
            <option value="all">All folders</option>
            <option value="builds">Build output</option>
            <option value="dependencies">Dependencies</option>
            <option value="caches">Caches</option>
            <option value="worktrees">Git worktrees</option>
            {onFindIgnored && (
              <option value="ignored">Git-ignored folders</option>
            )}
          </select>
        </label>
      </div>
      {!valid && (
        <div className="alert error" role="alert">
          Enter a size from 0 to {folderBytes(1024 ** 5)}.
        </div>
      )}
      {category === "ignored" && onFindIgnored && (
        <IgnoredFolders
          scanId={scan.id}
          minimumBytes={Math.round(minimum * 1000000)}
          query={query}
          valid={valid}
          onFind={onFindIgnored}
          onReveal={onReveal}
          onPrepare={onPrepare}
        />
      )}
      {category !== "ignored" && (
        <>
          <div className="folder-total-summary" role="status">
            <strong>
              {valid ? tree.matches.size.toLocaleString() : 0} matching folders
            </strong>
            <span>
              {scan.fileCount.toLocaleString()} file entries in totals
            </span>
            <span>
              Search area: {scan.folderSizing?.estimated ? "≈ " : ""}
              {folderBytes(scan.totalBytes)}
            </span>
          </div>
          <p className="folder-accounting">
            500 MB = 500,000,000 bytes. Parent totals include children;
            overlapping totals are never added. These are logical sizes, not
            deletion savings. Category filters use folder names and Git markers;
            they do not establish safe deletion.
          </p>
          {scan.folderSizing?.estimated && (
            <div className="alert">
              <span>
                <strong>Estimated from saved branch totals.</strong>{" "}
                {scan.folderSizing.cachedBranchCount} small branches reused
                {scan.folderSizing.cacheDate
                  ? ` from ${date(scan.folderSizing.cacheDate)}`
                  : ""}
                . Changes inside skipped branches may be missing. Run a scan
                with Quick scan unchecked for fresh totals.
              </span>
            </div>
          )}
          {!!scan.folderSizing?.prunedDirectoryCount && (
            <p className="folder-accounting">
              {scan.folderSizing.prunedDirectoryCount.toLocaleString()} known
              directories pruned in Quick scan. Lowering this view’s threshold
              cannot recover skipped descendants; use a fresh scan to measure
              them.
            </p>
          )}
          {(!scan.folderSizing ||
            (scan.status !== "completed" && !scan.folderSizing.estimated) ||
            scan.skipped.length > 0 ||
            scan.errors.length > 0 ||
            (scan.folderSizing.scopeComplete === false &&
              !scan.folderSizing.estimated)) && (
            <div className="alert">
              <span>
                {!scan.folderSizing
                  ? "Saved full-scan totals may have capped coverage. Run a folder totals scan to measure the search area without a file cap."
                  : "Coverage is incomplete. Skipped or inaccessible paths can leave totals understated; review scan coverage."}
              </span>
            </div>
          )}
          {valid && (
            <div className="folder-tree" aria-label="Folder totals hierarchy">
              {renderFolder(tree.root, 0)}
            </div>
          )}
          {valid && !tree.matches.size && (
            <div className="empty">
              <Folder size={30} />
              <h3>No counted folders match</h3>
              <p>Lower the threshold, clear filters, or scan another folder.</p>
            </div>
          )}
          <div className="table-footer">
            <span>Largest subfolders first · ancestor context retained</span>
            <span>Read-only folder inventory</span>
          </div>
        </>
      )}
    </section>
  );
}
