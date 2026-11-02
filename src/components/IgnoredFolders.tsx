import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FolderGit2, RefreshCw } from "lucide-react";
import { basename } from "../types";
import type { IgnoredFolderResult } from "../types";
import { folderBytes } from "../folder-format";

export function IgnoredFolders({
  scanId,
  minimumBytes,
  query,
  valid,
  onFind,
  onReveal,
  onPrepare,
}: {
  scanId: string;
  minimumBytes: number;
  query: string;
  valid: boolean;
  onFind: (minimumBytes: number) => Promise<IgnoredFolderResult>;
  onReveal: (path: string) => void;
  onPrepare?: (request: { scanId: string; directoryPath: string }) => void;
}) {
  const [result, setResult] = useState<IgnoredFolderResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(50);
  const revision = useRef(0);
  async function run() {
    if (!valid) return;
    const current = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const next = await onFind(minimumBytes);
      if (revision.current === current) {
        setResult(next);
        setLimit(50);
      }
    } catch (e) {
      if (revision.current === current) setError((e as Error).message);
    } finally {
      if (revision.current === current) setBusy(false);
    }
  }
  useEffect(() => {
    void run();
    return () => {
      revision.current++;
    };
  }, [scanId]);
  const stale = result && result.minimumBytes !== minimumBytes;
  const targets =
    result?.targets.filter((item) =>
      item.path.toLowerCase().includes(query.trim().toLowerCase()),
    ) || [];
  return (
    <div className="ignored-operation">
      <div className="ignored-operation-heading">
        <div>
          <h3>
            Git-ignored folders above{" "}
            {valid ? folderBytes(minimumBytes) : "your threshold"}
          </h3>
          <p>
            A repeatable review of ignored folders. Your threshold is remembered
            on this browser.
          </p>
        </div>
        <button
          className="primary small"
          disabled={busy || !valid}
          onClick={() => void run()}
        >
          <RefreshCw size={15} className={busy ? "spin" : ""} />
          {busy ? "Checking Git rules…" : "Run ignored-folder check"}
        </button>
      </div>
      <p className="folder-accounting">
        Ignore status is checked now. Sizes come from this scan. Review cleanup
        checks current contents and rebuild instructions before confirmation.
      </p>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {stale && (
        <div className="alert" role="status">
          The threshold changed. Run the operation again to update these
          results.
        </div>
      )}
      {result && (
        <>
          <div className="folder-total-summary" role="status">
            <strong>{targets.length.toLocaleString()} ignored folders</strong>
            <span>
              {targets.some((item) => item.estimated) ? "≈ " : ""}
              {folderBytes(
                targets.reduce((total, item) => total + item.bytes, 0),
              )}{" "}
              recorded logical total · no overlapping rows
            </span>
            <span>
              Git checked {new Date(result.checkedAt).toLocaleString()}
            </span>
          </div>
          <details className="ignored-notes">
            <summary>Size and safety notes</summary>
            {result.notices.map((notice) => (
              <p className="folder-accounting" key={notice}>
                {notice}
              </p>
            ))}
          </details>
          {(!result.coverage.complete ||
            result.errors.length > 0 ||
            result.skipped.length > 0) && (
            <details className="alert ignored-coverage">
              <summary>
                Partial Git inspection · {result.coverage.checkedDirectories} of{" "}
                {result.coverage.candidateCount} candidate folders checked
              </summary>
              {[...result.errors, ...result.skipped]
                .slice(0, 20)
                .map((item) => (
                  <p key={item.path}>
                    <code>{item.path}</code> — {item.reason}
                  </p>
                ))}
            </details>
          )}
          <div aria-label="Git-ignored folder results" aria-busy={busy}>
            {targets.slice(0, limit).map((item) => (
              <div
                className="folder-tree-row ignored-folder-row"
                key={item.path}
              >
                <div className="folder-tree-name">
                  <FolderGit2 size={19} />
                  <div className="large-folder-path">
                    <strong>{basename(item.path)}</strong>
                    {!item.cleanupSupported && (
                      <span className="folder-context">Review only</span>
                    )}
                    <code>{item.path}</code>
                    <small>
                      Ignored by {item.ignore.source}:{item.ignore.line} ·{" "}
                      <code>{item.ignore.pattern}</code>
                    </small>
                    <small>Repository: {item.repository}</small>
                    <small>{item.reason}</small>
                    <small>
                      {item.estimated
                        ? "Estimated scan size"
                        : item.complete === false
                          ? "Incomplete scan size"
                          : "Recorded scan size"}{" "}
                      · {new Date(result.recordedAt).toLocaleString()}
                    </small>
                  </div>
                </div>
                <div
                  className="large-folder-bytes"
                  title={`${item.bytes.toLocaleString()} bytes`}
                >
                  <strong>
                    {item.estimated ? "≈ " : ""}
                    {folderBytes(item.bytes)}
                  </strong>
                </div>
                <div className="folder-row-actions">
                  {onPrepare && item.cleanupSupported && (
                    <button
                      className="secondary small"
                      disabled={busy || !!stale || !!error}
                      aria-label={`Review cleanup for ${item.path}`}
                      onClick={() =>
                        onPrepare({ scanId, directoryPath: item.path })
                      }
                    >
                      Review cleanup
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    aria-label={`Open folder ${item.path}`}
                    onClick={() => onReveal(item.path)}
                  >
                    <ArrowUpRight size={17} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {targets.length > limit && (
            <button
              className="secondary small"
              onClick={() => setLimit(limit + 50)}
            >
              Show more ignored folders
            </button>
          )}
          {!targets.length && (
            <div className="empty">
              <FolderGit2 size={30} />
              <h3>No ignored folders match</h3>
              <p>Lower the threshold or run a fresh scan of your projects.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
