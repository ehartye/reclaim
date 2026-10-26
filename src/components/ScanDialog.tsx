import { useState } from "react";
import { Folder, X, ShieldCheck, LoaderCircle, Search } from "lucide-react";
import { Dialog } from "./Dialog";
import { basename } from "../types";
import type { State, Settings } from "../types";
export function ScanDialog({
  state,
  settings,
  onClose,
  onStart,
  busy,
  setBusy,
  preset,
}: {
  state: State | null;
  settings: Settings;
  onClose: () => void;
  onStart: (v: {
    root: string;
    operation: "folder-sizes";
    folderMinBytes: number;
    folderScanMode: "quick" | "fresh";
  }) => Promise<void>;
  busy: boolean;
  setBusy: (v: boolean) => void;
  preset?: { root?: string; operation?: string; folderMinBytes?: number };
}) {
  const [root, setRoot] = useState(
      preset?.root ||
        state?.scans[0]?.root ||
        state?.locations.find((l) => l.label === "Downloads")?.path ||
        state?.locations[0]?.path ||
        "",
    ),
    [folderMB, setFolderMB] = useState(
      (preset?.folderMinBytes ?? 500000000) / 1000000,
    ),
    [quick, setQuick] = useState(true),
    [error, setError] = useState("");
  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onStart({
              root,
              operation: "folder-sizes",
              folderMinBytes: Math.round(folderMB * 1000000),
              folderScanMode: quick ? "quick" : "fresh",
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">A LITTLE ROOM STARTS HERE</span>
            <h2>Scan a folder</h2>
            <p>
              Start with folder totals. Inspect individual files when you need
              them.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close scan dialog"
          >
            <X size={20} />
          </button>
        </div>
        <div className="scan-form">
          <label className="input-label" htmlFor="scan-root">
            Folder path
          </label>
          <div className="path-input">
            <Folder size={18} />
            <input
              autoFocus
              id="scan-root"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="C:\Users\You\Downloads"
              required
            />
          </div>
          <div className="location-chips">
            {[
              ...(state?.locations || []),
              ...settings.developmentRoots
                .filter((p) => !state?.locations.some((l) => l.path === p))
                .map((p) => ({ path: p, label: basename(p) })),
            ].map((l) => (
              <button
                type="button"
                key={l.path}
                className={root === l.path ? "chosen" : ""}
                onClick={() => setRoot(l.path)}
              >
                <Folder size={13} />
                {l.label}
              </button>
            ))}
          </div>
          <label className="input-label" htmlFor="folder-minimum">
            Folder size greater than
          </label>
          <div className="folder-threshold">
            <input
              id="folder-minimum"
              type="number"
              min="0"
              max={1024 ** 5 / 1000000}
              step="any"
              required
              value={Number.isNaN(folderMB) ? "" : folderMB}
              onChange={(e) => setFolderMB(e.target.valueAsNumber)}
            />
            <span>MB</span>
          </div>
          <label className="scan-option">
            <input
              type="checkbox"
              aria-label="Quick scan"
              checked={quick}
              onChange={(e) => setQuick(e.target.checked)}
            />
            <div>
              <strong>Quick scan</strong>
              <p>
                Reuse dated, complete totals for small branches. These estimates
                can miss changes inside those folders. Uncheck for a fresh scan
                that measures every accessible branch.
              </p>
            </div>
          </label>
          <div className="restore-note">
            <strong>
              {quick
                ? "Small known branches can be skipped"
                : "Fresh folder totals"}
            </strong>
            <p>
              First-time and unknown folders are measured from file metadata. No
              file or directory cap. 500 MB means 500,000,000 bytes. Individual
              file lists load only when you inspect a folder.
            </p>
          </div>
          <div className="scan-safety">
            <ShieldCheck size={19} />
            <div>
              <strong>Your files stay as they are</strong>
              <p>
                Read-only scan. Links, offline files and protected system
                folders are skipped.
              </p>
            </div>
          </div>
          {!!settings.exclusions.length && (
            <p className="fine-print">
              {settings.exclusions.length} exclusions from your scan settings
              will apply.
            </p>
          )}
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !!state?.job || !state}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Search size={16} />
            )}
            Start scan
          </button>
        </div>
      </form>
    </Dialog>
  );
}
