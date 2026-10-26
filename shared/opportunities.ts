export type OpportunityTarget = {
  id: string;
  path: string;
  category: string;
  kind: string;
  label: string;
  restore: string;
  cleanupSupported: boolean;
  locked?: boolean;
  blockedReason?: string;
};
export type RecordedOpportunity = {
  path?: string;
  recordedAt?: string;
  scanId?: string;
  scanStatus?: string;
  logicalBytes: number;
  exclusiveLogicalBytes: number;
  sharedLogicalBytes?: number;
  fileCount?: number;
  newestWriteAt: number | null;
  coverageComplete: boolean;
};
export type FolderMeasurement = {
  path: string;
  measuredAt: string;
  status: "complete" | "partial" | "cancelled";
  logicalBytes: number;
  allocatedBytes: number | null;
  exclusiveAllocatedBytes: number | null;
  sharedAllocatedBytes: number | null;
  fileCount: number;
  newestActivityAt: number | null;
  skippedCount: number;
  errorCount: number;
  notices: string[];
  basis: "allocated" | "logical-only";
};
export type ActivityHint = {
  latestAt: number | null;
  checkedAt: string;
  evidence: string[];
  complete?: false;
  error?: string;
};
export type OpportunityEvidence = {
  changes?: { path: string; changedAt: number }[];
  recorded?: RecordedOpportunity;
  measurement?: FolderMeasurement;
  activity?: ActivityHint;
};
export type OpportunityRules = {
  recipe: string;
  olderDays: number;
  minimumBytes: number;
  now?: number;
};
export type OpportunityCandidate = {
  target: OpportunityTarget;
  id: string;
  path: string;
  visible: boolean;
  confirmed: boolean;
  ageState: "recent" | "confirmed-old" | "possible-old" | "unknown";
  latestActivityAt: number | null;
  gainBytes: number | null;
  gainBasis: "allocated" | "measured-logical" | "recorded-logical" | "unknown";
  partial: boolean;
  fresh: boolean;
  measuredAt?: string;
  recordedAt?: string;
  restoreCost: string;
  evidence: OpportunityEvidence;
};
const validNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
export function evaluateOpportunity(
  target: OpportunityTarget,
  evidence: OpportunityEvidence,
  rules: OpportunityRules,
): OpportunityCandidate {
  const now = rules.now ?? Date.now(),
    cutoff = now - Math.max(0, rules.olderDays) * 86400000,
    changedAt = latestChange(target.path, evidence.changes || []),
    m =
      evidence.measurement &&
      Date.parse(evidence.measurement.measuredAt) > changedAt
        ? evidence.measurement
        : undefined,
    r =
      evidence.recorded &&
      (!changedAt || Date.parse(evidence.recorded.recordedAt || "") > changedAt)
        ? evidence.recorded
        : undefined;
  const newerRecorded = Boolean(
    m &&
    r &&
    Date.parse(r.recordedAt || "") > Date.parse(m.measuredAt) &&
    (r.logicalBytes !== m.logicalBytes ||
      (r.fileCount !== undefined && r.fileCount !== m.fileCount) ||
      (validNumber(r.newestWriteAt) &&
        r.newestWriteAt > (m.newestActivityAt || 0) + 1) ||
      (r.sharedLogicalBytes || 0) > 0 ||
      (r.exclusiveLogicalBytes === 0 && (m.exclusiveAllocatedBytes || 0) > 0)),
  );
  const newerProbe = Boolean(
    m &&
    evidence.activity &&
    Date.parse(evidence.activity.checkedAt) > Date.parse(m.measuredAt) &&
    (evidence.activity.latestAt || 0) > (m.newestActivityAt || 0) + 1,
  );
  const superseded = newerRecorded || newerProbe;
  const fresh = Boolean(
    !superseded &&
    m &&
    Number.isFinite(Date.parse(m.measuredAt)) &&
    now - Date.parse(m.measuredAt) <= 15 * 60000 &&
    now >= Date.parse(m.measuredAt),
  );
  const complete = Boolean(
    fresh &&
    m?.status === "complete" &&
    m.skippedCount === 0 &&
    m.errorCount === 0,
  );
  let gainBytes: number | null = null,
    gainBasis: OpportunityCandidate["gainBasis"] = "unknown",
    partial = false;
  if (m && !superseded) {
    if (
      m.status !== "cancelled" &&
      (m.status === "complete" ||
        (m.fileCount > 0 && (m.exclusiveAllocatedBytes || 0) > 0)) &&
      m.basis === "allocated" &&
      validNumber(m.exclusiveAllocatedBytes)
    ) {
      gainBytes = m.exclusiveAllocatedBytes;
      gainBasis = "allocated";
    }
    // A total logical size cannot establish exclusive gain when allocation/link accounting is unavailable.
    partial = m.status !== "complete" || m.skippedCount > 0 || m.errorCount > 0;
  }
  if (gainBytes === null && r && validNumber(r.exclusiveLogicalBytes)) {
    gainBytes = r.exclusiveLogicalBytes;
    gainBasis = "recorded-logical";
    partial = partial || !r.coverageComplete;
  }
  const probeAfterMeasurement =
    !complete ||
    Date.parse(evidence.activity?.checkedAt || "") >
      Date.parse(m?.measuredAt || "");
  const dates = [
    ...(probeAfterMeasurement ? [evidence.activity?.latestAt] : []),
    ...(complete
      ? [m?.newestActivityAt]
      : [m?.newestActivityAt, r?.newestWriteAt]),
  ].filter((v): v is number => validNumber(v) && v > 0);
  const latestActivityAt = dates.length ? Math.max(...dates) : null;
  const ageState: OpportunityCandidate["ageState"] =
    latestActivityAt !== null && latestActivityAt > cutoff
      ? "recent"
      : complete && m?.newestActivityAt && latestActivityAt !== null
        ? "confirmed-old"
        : latestActivityAt !== null
          ? "possible-old"
          : "unknown";
  const oldRecipe = rules.recipe.startsWith("old-");
  const supported = target.cleanupSupported && !target.locked;
  const typeMatches =
    rules.recipe === "old-dependencies"
      ? target.category === "dependencies" && supported
      : rules.recipe === "old-builds"
        ? target.category === "builds" && supported
        : rules.recipe === "largest"
          ? ["dependencies", "builds"].includes(target.category) && supported
          : true;
  const sizeMatches =
    gainBytes === null || partial || gainBytes >= rules.minimumBytes;
  const visible =
    typeMatches && sizeMatches && (!oldRecipe || ageState !== "recent");
  const confirmed =
    visible &&
    supported &&
    complete &&
    gainBytes !== null &&
    gainBytes >= rules.minimumBytes &&
    (!oldRecipe || ageState === "confirmed-old");
  const restoreCost = /unity|godot/i.test(target.label)
    ? "Asset reimport; potentially expensive"
    : target.category === "dependencies"
      ? "Reinstall packages; downloads or private feeds may be required"
      : target.category === "builds"
        ? /rust|\.net/i.test(target.label)
          ? "Recompile project"
          : "Run the project build"
        : target.kind === "worktree"
          ? "Recreate the checkout; preserve commits and local work first"
          : "Owner-specific cleanup; manual review";
  return {
    target,
    id: target.id,
    path: target.path,
    visible,
    confirmed,
    ageState,
    latestActivityAt,
    gainBytes,
    gainBasis,
    partial,
    fresh,
    measuredAt: m?.measuredAt,
    recordedAt: r?.recordedAt,
    restoreCost,
    evidence,
  };
}
const normalized = (p: string) =>
  p
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
export function latestChange(
  target: string,
  changes: { path: string; changedAt: number }[],
) {
  const p = normalized(target);
  return changes.reduce((latest, change) => {
    const other = normalized(change.path);
    return p === other || p.startsWith(other + "/") || other.startsWith(p + "/")
      ? Math.max(latest, change.changedAt || 0)
      : latest;
  }, 0);
}
export function withoutOverlappingTargets<T extends { path: string }>(
  items: T[],
): T[] {
  const out: T[] = [];
  for (const item of [...items].sort((a, b) => a.path.length - b.path.length)) {
    const p = normalized(item.path);
    if (
      !out.some(
        (x) =>
          p === normalized(x.path) || p.startsWith(normalized(x.path) + "/"),
      )
    )
      out.push(item);
  }
  return out;
}
export function opportunityTotals(items: OpportunityCandidate[]) {
  const selected = withoutOverlappingTargets(
    items.filter((x) => x.visible && !x.target.blockedReason),
  );
  const allocated = selected.filter(
    (x) => x.fresh && !x.partial && x.gainBasis === "allocated",
  );
  return {
    measuredGainBytes: allocated.reduce((n, x) => n + (x.gainBytes || 0), 0),
    measuredCount: allocated.length,
    pendingCount: selected.filter(
      (x) => !x.fresh || x.partial || x.gainBytes === null,
    ).length,
    recordedLogicalBytes: selected
      .filter((x) => x.gainBasis === "recorded-logical")
      .reduce((n, x) => n + (x.gainBytes || 0), 0),
    recordedCount: selected.filter((x) => x.gainBasis === "recorded-logical")
      .length,
    measuredLogicalBytes: selected
      .filter((x) => x.gainBasis === "measured-logical")
      .reduce((n, x) => n + (x.gainBytes || 0), 0),
    unmeasuredCount: selected.filter((x) => x.gainBytes === null).length,
    confirmedCount: selected.filter((x) => x.confirmed).length,
    count: selected.length,
  };
}
export function compareOpportunities(
  a: OpportunityCandidate,
  b: OpportunityCandidate,
) {
  return (
    Number(b.confirmed) - Number(a.confirmed) ||
    (b.gainBytes ?? -1) - (a.gainBytes ?? -1) ||
    a.path.localeCompare(b.path)
  );
}
