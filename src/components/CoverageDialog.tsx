import { X } from "lucide-react";
import { Dialog } from "./Dialog";

import type { Scan } from "../types";
import { presentScanCoverage } from "../scan-coverage";
function Paths({ entries }: { entries: Scan["skipped"] }) {
  return (
    <>
      {entries.map((entry, index) => (
        <div className="coverage-item" key={index}>
          <code>{entry.path}</code>
          <small>{entry.reason}</small>
        </div>
      ))}
    </>
  );
}
export function CoverageDialog({
  scan,
  onClose,
}: {
  scan: Scan;
  onClose: () => void;
}) {
  const coverage = presentScanCoverage(scan);
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
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="coverage-summary">
        <span>
          <b>{scan.fileCount.toLocaleString()}</b> files counted
        </span>
        <span>
          <b>{scan.directoryCount.toLocaleString()}</b> folders recorded
        </span>
        <span>
          <b>{coverage.label}</b> scan outcome
        </span>
      </div>
      <div className="coverage-body coverage-decision">
        <p className="coverage-lead">{coverage.summary}</p>
        {coverage.issueCount > 0 && (
          <section>
            <h3>Needs attention ({coverage.issueCount} recorded)</h3>
            <p>
              Unreadable or changing folders can leave gaps. Review these paths;
              retry a narrower scan when access or activity permits.
            </p>
            <Paths entries={scan.errors} />
            <Paths entries={coverage.unresolved} />
          </section>
        )}
        {coverage.cacheNotices.length > 0 && (
          <section>
            <h3>Cache was not saved</h3>
            <p>
              These scan results remain available. A later scan may need to
              count folders again.
            </p>
            {coverage.cacheNotices.map((notice, index) => (
              <p key={index}>{notice}</p>
            ))}
          </section>
        )}
        <section>
          <h3>What the sizes cover</h3>
          <p>{coverage.sizeExplanation}</p>
          <p>
            Parent and child totals overlap. Logical file-entry sizes can count
            hardlinked names more than once; they are not physical deletion
            savings.
          </p>
        </section>
        <section>
          <h3>Exclusions and protections</h3>
          <p>
            These entries were deliberately not inspected. They do not by
            themselves mean the scan failed. Their contents remain outside the
            measured totals.
          </p>
          {coverage.groups.map((group) => (
            <details className="coverage-group" key={group.label}>
              <summary>
                {group.label}{" "}
                <span>({group.paths.length.toLocaleString()} recorded)</span>
              </summary>
              <Paths entries={group.paths} />
            </details>
          ))}
          {!coverage.groups.length && (
            <p>No recognized exclusions or protections were recorded.</p>
          )}
          <p className="fine-print">
            {coverage.truncated
              ? "This report reached the 1,000-entry detail limit. These are recorded samples, not complete category totals; further omissions or errors may be absent."
              : "Counts describe recorded entries in this saved report."}{" "}
            A grouped link/offline/cloud reason does not identify which
            protection applied.
          </p>
        </section>
        <details className="coverage-group">
          <summary>Scan settings and diagnostics</summary>
          <p>
            Recorded status: {scan.status}. Recorded at:{" "}
            {scan.completedAt || scan.startedAt}.
          </p>
          <p>
            Folder totals scan; no file or directory cap. Exclusions and
            link/cloud/system protections apply.
          </p>
          {coverage.notices.map((notice, index) => (
            <p key={index}>{notice}</p>
          ))}
        </details>
      </div>
    </Dialog>
  );
}
