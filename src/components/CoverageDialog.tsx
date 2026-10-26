import { X } from "lucide-react";
import { Dialog } from "./Dialog";
import { bytes } from "../types";
import type { Scan } from "../types";
export function CoverageDialog({
  scan,
  onClose,
}: {
  scan: Scan;
  onClose: () => void;
}) {
  return (
    <Dialog label="Scan coverage" onClose={onClose}>
      <div className="modal-heading">
        <div>
          <h2>Scan coverage</h2>
          <p>{scan.root}</p>
        </div>
        <button
          className="icon-btn"
          aria-label="Close coverage"
          onClick={() => onClose()}
        >
          <X size={20} />
        </button>
      </div>
      <div className="coverage-summary">
        <span>
          <b>{scan.fileCount.toLocaleString()}</b> files
        </span>
        <span>
          <b>{scan.directoryCount.toLocaleString()}</b> folders
        </span>
        <span>
          <b>{scan.status}</b> status
        </span>
      </div>
      <div className="coverage-body">
        <h3>Scan limits</h3>
        {scan.folderSizing ? (
          <p>
            Folder totals scan · no full-scan file cap · logical file-entry
            sizes · exclusions and link/cloud/system protections apply.
          </p>
        ) : (
          <p>
            {scan.options.maxFiles.toLocaleString()} files maximum ·{" "}
            {bytes(scan.options.minimumBytes)} minimum finding ·{" "}
            {scan.options.staleDays} days old · duplicate checks{" "}
            {scan.options.duplicates ? "on" : "off"}
          </p>
        )}
        {scan.notices.map((n) => (
          <div className="alert" key={n}>
            {n}
          </div>
        ))}
        <h3>
          Skipped paths ({scan.skipped.length}
          {scan.skipped.length === 1000 ? "+" : ""})
        </h3>
        {scan.skipped.length ? (
          scan.skipped.map((s, i) => (
            <div className="coverage-item" key={i}>
              <code>{s.path}</code>
              <small>{s.reason}</small>
            </div>
          ))
        ) : (
          <p>No skipped paths were recorded.</p>
        )}
        <h3>Errors ({scan.errors.length})</h3>
        {scan.errors.map((s, i) => (
          <div className="coverage-item" key={i}>
            <code>{s.path}</code>
            <small>{s.reason}</small>
          </div>
        ))}
        <p className="fine-print">
          Skipped and error lists retain the first 1,000 entries each. A partial
          scan only describes the files it could analyze.
        </p>
      </div>
    </Dialog>
  );
}
