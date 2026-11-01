import { useEffect, useState } from "react";
import { Trash2, LoaderCircle, X, TriangleAlert } from "lucide-react";
import { Dialog } from "./Dialog";
import { bytes } from "../types";
import type { CleanupPreview, CleanupRecord } from "../types";
export function CleanupDialog({
  request,
  prepare,
  api,
  onClose,
  onDone,
}: {
  request: object;
  prepare?: (request: object) => Promise<CleanupPreview>;
  api: (url: string, body?: unknown) => Promise<any>;
  onClose: () => void;
  onDone: (result: CleanupRecord) => void;
}) {
  const [preview, setPreview] = useState<CleanupPreview | null>(null),
    [phrase, setPhrase] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [result, setResult] = useState<CleanupRecord | null>(null);
  useEffect(() => {
    let live = true;
    (prepare ? prepare(request) : api("cleanup/prepare", request))
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <Dialog
      label="Confirm permanent deletion"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-heading">
        <div>
          <span className="section-kicker danger-text">PERMANENT CLEANUP</span>
          <h2>{result ? "Cleanup result" : "Review before deleting"}</h2>
          <p>Exact target. Fresh inspection. Your confirmation.</p>
        </div>
        <button
          className="icon-btn"
          aria-label="Close cleanup"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="scan-form cleanup-body">
        {loading && (
          <p role="status">
            <LoaderCircle className="spin" size={18} /> Inspecting the current
            folder and checking safety…
          </p>
        )}
        {preview && (
          <>
            <p className="cleanup-target">{preview.path}</p>
            <div className="cleanup-size">
              <b>{bytes(preview.bytes)}</b>
              <span>
                {preview.fileCount.toLocaleString()} files · current logical
                size
              </span>
            </div>
            <p>{preview.reason}</p>
            <div className="restore-note">
              <strong>To use this project again</strong>
              <p>{preview.restore}</p>
            </div>
            <ul className="cleanup-warnings">
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            {!result && (
              <>
                <label className="input-label" htmlFor="delete-phrase">
                  Type <strong>{preview.phrase}</strong> to confirm
                </label>
                <input
                  id="delete-phrase"
                  autoComplete="off"
                  spellCheck={false}
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  disabled={busy}
                />
                <p className="fine-print">
                  This preview expires after five minutes. Changes require a new
                  preview.
                </p>
              </>
            )}
          </>
        )}
        {error && (
          <div className="alert error" role="alert">
            <TriangleAlert size={18} />
            {error}
          </div>
        )}
        {result && (
          <div
            className={
              result.status === "deleted" ? "restore-note" : "alert error"
            }
            role="status"
          >
            <strong>
              {result.status === "deleted"
                ? "Deleted permanently"
                : result.status === "partial"
                  ? "Cleanup stopped after partial deletion"
                  : "Nothing was deleted"}
            </strong>
            <p>
              {result.deletedFiles} files removed · {bytes(result.deletedBytes)}{" "}
              logical bytes. {result.error}{" "}
              {result.status === "deleted"
                ? "Recorded in cleanup history."
                : ""}
            </p>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="secondary" disabled={busy} onClick={onClose}>
          {result ? "Close" : "Cancel"}
        </button>
        {preview && !result && (
          <button
            className="danger-btn"
            disabled={busy || phrase !== preview.phrase}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r: CleanupRecord = await api("cleanup/execute", {
                  id: preview.id,
                  confirmation: phrase,
                });
                setResult(r);
                onDone(r);
              } catch (e) {
                setError((e as Error).message);
                setPreview(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Trash2 size={16} />
            )}{" "}
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        )}
      </div>
    </Dialog>
  );
}
