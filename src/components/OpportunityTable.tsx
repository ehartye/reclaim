import {
  Copy,
  Files,
  Folder,
  ChevronRight,
  FileSearch,
  ShieldCheck,
  EyeOff,
  CheckCircle2,
  Undo2,
} from "lucide-react";
import { bytes, categories } from "../types";
import type { Finding, Review } from "../types";
import type { DispositionAction } from "../../shared/review.ts";
export function OpportunityTable({
  items,
  review,
  toggle,
  onInspect,
  emptyQueue,
  emptyDone = false,
  onReset,
  onDisposition,
}: {
  items: Finding[];
  review: Review;
  toggle: (f: Finding) => void;
  onInspect: (f: Finding) => void;
  emptyQueue: boolean;
  emptyDone?: boolean;
  onReset: () => void;
  onDisposition: (ids: string[], action: DispositionAction) => void;
}) {
  return items.length ? (
    <div className="finding-table">
      <div className="table-head">
        <span>Opportunity</span>
        <span>Type</span>
        <span>Estimated size</span>
        <span>Impact</span>
        <span />
      </div>
      {items.map((f) => (
        <div
          className={
            "finding-row " +
            (review.ignored.includes(f.id) ? "muted-row" : "") +
            (review.resolved.includes(f.id) ? " resolved-row" : "")
          }
          key={f.id}
        >
          <div className="finding-main">
            <input
              type="checkbox"
              aria-label={`Add ${f.path} to review`}
              checked={review.selected.includes(f.id)}
              onChange={() => toggle(f)}
            />
            <span
              className="file-symbol"
              style={{
                color: categories[f.category].color,
                background: categories[f.category].color + "12",
              }}
            >
              {f.category === "duplicates" ? (
                <Copy size={18} />
              ) : f.fileCount === 1 ? (
                <Files size={18} />
              ) : (
                <Folder size={18} />
              )}
            </span>
            <button className="row-title" onClick={() => onInspect(f)}>
              <strong>{f.title}</strong>
              {review.resolved.includes(f.id) && (
                <span className="resolved-label">
                  <CheckCircle2 size={10} />
                  Resolved
                </span>
              )}
              <small title={f.path}>{f.path}</small>
            </button>
          </div>
          <span className="category-label">
            <i style={{ background: categories[f.category].color }} />
            {categories[f.category].label}
          </span>
          <strong className="size">{bytes(f.bytes)}</strong>
          <span className={"risk " + f.risk}>
            {f.risk === "low" ? (
              <ShieldCheck size={13} />
            ) : (
              <EyeOff size={13} />
            )}{" "}
            {f.risk === "low" ? "Rebuildable" : "Review first"}
          </span>
          <div className="row-actions">
            <button
              className="icon-btn resolve-btn"
              title={
                review.resolved.includes(f.id) ? "Reopen" : "Mark resolved"
              }
              aria-label={`${review.resolved.includes(f.id) ? "Reopen" : "Mark resolved"} ${f.path}`}
              onClick={() =>
                onDisposition(
                  [f.id],
                  review.resolved.includes(f.id) ? "reopen" : "resolve",
                )
              }
            >
              {review.resolved.includes(f.id) ? (
                <Undo2 size={16} />
              ) : (
                <CheckCircle2 size={17} />
              )}
            </button>
            <button
              className="icon-btn"
              aria-label={`Inspect ${f.path}`}
              onClick={() => onInspect(f)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div className="empty">
      <FileSearch size={34} />
      <h3>
        {emptyDone
          ? "All opportunities handled"
          : emptyQueue
            ? "Your review queue is clear"
            : "No matching opportunities"}
      </h3>
      <p>
        {emptyDone
          ? "Resolved items are saved in this report. Reopen one whenever it needs attention."
          : emptyQueue
            ? review.resolved.length
              ? "Completed items are saved under Resolved. You can reopen them at any time."
              : "Select opportunities to collect them here."
            : "Try another filter, lower the minimum size, or scan another folder."}
      </p>
      <button className="secondary" onClick={onReset}>
        {emptyDone
          ? "View resolved items"
          : emptyQueue
            ? review.resolved.length
              ? "View resolved items"
              : "Explore opportunities"
            : "Clear filters"}
      </button>
    </div>
  );
}
