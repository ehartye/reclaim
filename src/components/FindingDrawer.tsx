import {
  FolderOpen,
  X,
  ExternalLink,
  Copy,
  ArrowUpRight,
  Check,
  EyeOff,
  Plus,
  CheckCircle2,
  Undo2,
  Trash2,
} from "lucide-react";
import { Dialog } from "./Dialog";
import { bytes, categories } from "../types";
import type { Finding, Review } from "../types";
import type { DispositionAction } from "../../shared/review.ts";
export function FindingDrawer({
  detail,
  review,
  onClose,
  reveal,
  copy,
  toggle,
  onDisposition,
  onCleanup,
}: {
  detail: Finding;
  review: Review;
  onClose: () => void;
  reveal: (p: string) => Promise<void>;
  copy: (p: string) => Promise<void>;
  toggle: (f: Finding) => void;
  onDisposition: (ids: string[], action: DispositionAction) => void;
  onCleanup?: () => void;
}) {
  return (
    <Dialog drawer onClose={onClose}>
      <div className="drawer-header">
        <span className="eyebrow">OPPORTUNITY DETAILS</span>
        <button
          className="icon-btn"
          onClick={() => onClose()}
          aria-label="Close details"
        >
          <X size={20} />
        </button>
      </div>
      <div className="drawer-body">
        <span
          className="detail-icon"
          style={{
            background: categories[detail.category].color + "15",
            color: categories[detail.category].color,
          }}
        >
          <FolderOpen size={30} />
        </span>
        <h2>{detail.title}</h2>
        <p className="detail-path">{detail.path}</p>
        <div className="detail-actions">
          <button
            className="secondary small"
            onClick={() => void reveal(detail.path)}
          >
            <ExternalLink size={14} />
            Open folder
          </button>
          <button
            className="secondary small"
            onClick={() => void copy(detail.path)}
          >
            <Copy size={14} />
            Copy path
          </button>
        </div>
        <div className="detail-stats">
          <div>
            <span>Estimated size</span>
            <b>{bytes(detail.bytes)}</b>
          </div>
          <div>
            <span>Files</span>
            <b>{detail.fileCount.toLocaleString()}</b>
          </div>
          <div>
            <span>Impact</span>
            <b className={"risk " + detail.risk}>
              {detail.risk === "low" ? "Rebuildable" : "Review first"}
            </b>
          </div>
        </div>
        {review.resolved.includes(detail.id) && (
          <div className="resolved-note">
            <CheckCircle2 size={17} />
            <span>
              Marked resolved in this scan. Reopen it to return it to active
              opportunities.
            </span>
          </div>
        )}
        <section>
          <h3>Why it’s here</h3>
          <p>{detail.reason}</p>
        </section>
        {detail.insight && (
          <section className="restore-note">
            <h3>Current project context</h3>
            {detail.insight.projectPath && (
              <p className="detail-path">{detail.insight.projectPath}</p>
            )}
            <p>{detail.insight.reason}</p>
            <strong>Recommended action / restore</strong>
            <p>{detail.insight.restore}</p>
          </section>
        )}
        <section>
          <h3>What to consider</h3>
          <p>{detail.impact}</p>
        </section>
        <section className="action-note">
          <h3>
            <ArrowUpRight size={17} />
            Suggested next step
          </h3>
          <p>{detail.action}</p>
        </section>
        <section>
          <h3>Evidence</h3>
          <ul className="evidence-list">
            {detail.evidence.map((e) => (
              <li key={e}>
                <Check size={14} />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </section>
        <p className="fine-print">
          Sizes are logical file sizes. Compression, sparse files, hardlinks and
          cloud storage can affect the space you actually recover. This scan
          does not delete files. Cleanup uses a fresh inspection and separate
          confirmation.
        </p>
        {onCleanup && (
          <section className="cleanup-entry">
            <h3>Ready to reclaim this folder?</h3>
            <p>
              Check the current size, project evidence and restoration steps
              before confirming permanent deletion.
            </p>
            <button className="secondary" onClick={onCleanup}>
              <Trash2 size={15} /> Review deletion
            </button>
          </section>
        )}
      </div>
      <div className="drawer-footer disposition-footer">
        <button
          className="text-btn"
          onClick={() => {
            onDisposition(
              [detail.id],
              review.ignored.includes(detail.id) ? "reopen" : "dismiss",
            );
            onClose();
          }}
        >
          <EyeOff size={15} />
          {review.ignored.includes(detail.id)
            ? "Restore finding"
            : "Dismiss finding"}
        </button>
        <button className="secondary" onClick={() => toggle(detail)}>
          {review.selected.includes(detail.id) ? (
            <Check size={16} />
          ) : (
            <Plus size={16} />
          )}{" "}
          {review.selected.includes(detail.id)
            ? "Remove from review"
            : review.resolved.includes(detail.id)
              ? "Reopen in review"
              : "Add to review"}
        </button>
        <button
          className="primary"
          onClick={() =>
            onDisposition(
              [detail.id],
              review.resolved.includes(detail.id) ? "reopen" : "resolve",
            )
          }
        >
          {review.resolved.includes(detail.id) ? (
            <Undo2 size={16} />
          ) : (
            <CheckCircle2 size={16} />
          )}{" "}
          {review.resolved.includes(detail.id) ? "Reopen" : "Mark resolved"}
        </button>
      </div>
    </Dialog>
  );
}
