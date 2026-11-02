import type {
  RoutineCandidate,
  RoutineDefinition,
  RoutinePreset,
  RoutinePresetState,
  RoutineRun,
} from "./routines.ts";

export type RoutineBatchCatalog = {
  definitions: RoutineDefinition[];
  presets: Record<string, RoutinePreset>;
  invalidPresets: RoutinePresetState["invalidPresets"];
};
export type RoutineBatchRequest = {
  routineId: string;
  parameters: Omit<RoutinePreset, "routineId">;
  scanId?: string;
};
export type RoutineBatchStatus =
  | "queued"
  | "running"
  | "successful"
  | "partial"
  | "failed"
  | "needs-settings"
  | "not-run";
export type RoutineSummary = {
  candidateCount: number;
  scopeCount: number;
  knownBytes: number | null;
  unknownSizeCount: number;
  estimated: boolean;
  incomplete: boolean;
  coverage: RoutineRun["coverage"];
  checkedAt: string;
  recordedAt: string[];
};
export type RoutineBatchRow<Run extends RoutineRun = RoutineRun> = {
  definition: RoutineDefinition;
  preset: RoutinePreset;
  status: RoutineBatchStatus;
  run?: Run;
  error?: string;
  receivedAt?: number;
  preparationDeadline?: number | null;
  summary?: RoutineSummary;
};
export type RoutineBatchState<Run extends RoutineRun = RoutineRun> = {
  catalog: RoutineBatchCatalog;
  rows: RoutineBatchRow<Run>[];
  scanId?: string;
  generation: number;
  status: "idle" | "refreshing" | "running" | "stopping" | "settled";
  refreshError?: string;
};

const LIFETIME = 5 * 60 * 1000;
const clone = <T>(value: T): T => structuredClone(value);
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const pathKey = (value: string) =>
  value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

// Keep parents even when unknown: a measured child cannot establish its size.
function outermostCandidates(candidates: RoutineCandidate[]) {
  return candidates.filter((candidate, index) => {
    const key = pathKey(candidate.path);
    return !candidates.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const parent = pathKey(other.path);
      return key === parent ? otherIndex < index : key.startsWith(`${parent}/`);
    });
  });
}

export function summarizeRoutineRun(
  run: RoutineRun,
  hasReport: boolean,
): RoutineSummary {
  const scopes = outermostCandidates(run.candidates);
  const known = scopes.filter(
    (candidate) =>
      hasReport &&
      typeof candidate.logicalBytes === "number" &&
      Number.isFinite(candidate.logicalBytes) &&
      candidate.logicalBytes >= 0,
  );
  return {
    candidateCount: run.candidates.length,
    scopeCount: scopes.length,
    knownBytes: known.length
      ? known.reduce((total, candidate) => total + candidate.logicalBytes!, 0)
      : null,
    unknownSizeCount: scopes.length - known.length,
    estimated: scopes.some((candidate) => candidate.estimated),
    incomplete: scopes.some((candidate) => !candidate.complete),
    coverage: clone(run.coverage),
    checkedAt: run.checkedAt,
    recordedAt: hasReport
      ? [
          ...new Set(
            known.flatMap((candidate) =>
              candidate.recordedAt ? [candidate.recordedAt] : [],
            ),
          ),
        ].sort()
      : [],
  };
}

/** Receipt and the server's own timestamp both cap the original evidence life. */
export function preparationDeadline(checkedAt: string, receivedAt: number) {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      checkedAt,
    );
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts;
  const daysInMonth = new Date(
    Date.UTC(Number(year), Number(month), 0),
  ).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  )
    return null;
  const checked = Date.parse(checkedAt);
  return Number.isFinite(checked) && Number.isFinite(receivedAt)
    ? Math.min(checked + LIFETIME, receivedAt + LIFETIME)
    : null;
}

export function isPreparationFresh(row: RoutineBatchRow, now = Date.now()) {
  return (
    !!row.run &&
    typeof row.preparationDeadline === "number" &&
    Number.isFinite(now) &&
    now < row.preparationDeadline
  );
}

export function sortedRoutineRows<Run extends RoutineRun>(
  rows: RoutineBatchRow<Run>[],
) {
  return [...rows].sort((a, b) => {
    const left = a.summary?.knownBytes ?? null;
    const right = b.summary?.knownBytes ?? null;
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  });
}

export function routineBatchProgress(state: RoutineBatchState) {
  const count = (status: RoutineBatchStatus) =>
    state.rows.filter((row) => row.status === status).length;
  const checked = count("successful") + count("partial");
  const failed = count("failed"),
    needsSettings = count("needs-settings");
  return {
    total: state.rows.length,
    checked,
    failed,
    needsSettings,
    processed: checked + failed + needsSettings,
    remaining: count("queued") + count("running"),
    notRun: count("not-run"),
    runningId: state.rows.find((row) => row.status === "running")?.definition
      .id,
  };
}

/** A foreground queue over the existing one-routine request; never retries. */
export class RoutineBatch<Run extends RoutineRun = RoutineRun> {
  private state: RoutineBatchState<Run>;
  private request: (request: RoutineBatchRequest) => Promise<Run>;
  private onChange?: (state: RoutineBatchState<Run>) => void;
  private now: () => number;
  private disposed = false;
  private stopRequested = false;
  private pendingStart = false;

  constructor(options: {
    catalog: RoutineBatchCatalog;
    scanId?: string;
    request: (request: RoutineBatchRequest) => Promise<Run>;
    onChange?: (state: RoutineBatchState<Run>) => void;
    now?: () => number;
  }) {
    this.request = options.request;
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    const catalog = clone(options.catalog);
    this.state = {
      catalog,
      rows: this.initialRows(catalog, "not-run"),
      scanId: options.scanId,
      generation: 0,
      status: "idle",
    };
  }

  getState() {
    return clone(this.state);
  }

  private initialRows(
    catalog: RoutineBatchCatalog,
    status: "queued" | "not-run",
  ): RoutineBatchRow<Run>[] {
    return catalog.definitions.map((definition) => ({
      definition,
      preset: catalog.presets[definition.id],
      status:
        catalog.invalidPresets[definition.id] || !catalog.presets[definition.id]
          ? "needs-settings"
          : status,
      ...(catalog.invalidPresets[definition.id]
        ? { error: catalog.invalidPresets[definition.id].error }
        : {}),
    }));
  }

  private emit() {
    if (!this.disposed) this.onChange?.(this.getState());
  }

  private active() {
    return ["refreshing", "running", "stopping"].includes(this.state.status);
  }

  async start(
    refreshCatalog: () => Promise<RoutineBatchCatalog>,
  ): Promise<boolean> {
    if (this.disposed || this.active() || this.pendingStart) return false;
    this.pendingStart = true;
    try {
      return await this.executeStart(refreshCatalog);
    } finally {
      this.pendingStart = false;
    }
  }

  private async executeStart(
    refreshCatalog: () => Promise<RoutineBatchCatalog>,
  ): Promise<boolean> {
    const generation = ++this.state.generation;
    const scanId = this.state.scanId;
    const current = () =>
      !this.disposed &&
      this.state.generation === generation &&
      this.state.scanId === scanId;
    this.stopRequested = false;
    this.state.status = "refreshing";
    delete this.state.refreshError;
    this.emit();
    let catalog: RoutineBatchCatalog;
    try {
      catalog = clone(await refreshCatalog());
    } catch (error) {
      if (current()) {
        this.state.status = "settled";
        this.state.refreshError = errorMessage(error);
        this.emit();
      }
      return false;
    }
    if (!current()) return false;
    this.state.catalog = catalog;
    this.state.rows = this.initialRows(catalog, "queued");
    this.state.status = this.stopRequested ? "stopping" : "running";
    this.emit();
    for (const row of this.state.rows) {
      if (!current()) return false;
      if (this.stopRequested) break;
      if (row.status !== "queued") continue;
      row.status = "running";
      this.emit();
      // An observer may dispose or stop while processing the running update.
      if (!current()) return false;
      if (this.stopRequested) {
        row.status = "not-run";
        break;
      }
      try {
        const preset = row.preset;
        const run = await this.request({
          routineId: row.definition.id,
          parameters: {
            minimumBytes: preset.minimumBytes,
            minimumAgeDays: preset.minimumAgeDays,
            roots: [...preset.roots],
            policyVersion: preset.policyVersion,
          },
          ...(scanId ? { scanId } : {}),
        });
        if (!current()) return false;
        this.fillResult(row, run);
      } catch (error) {
        if (!current()) return false;
        row.status = "failed";
        row.error = errorMessage(error);
      }
      this.emit();
    }
    if (!current()) return false;
    for (const row of this.state.rows)
      if (row.status === "queued") row.status = "not-run";
    this.state.status = "settled";
    this.emit();
    return true;
  }

  private fillResult(row: RoutineBatchRow<Run>, value: Run) {
    const run = clone(value);
    const receivedAt = this.now();
    row.run = run;
    row.receivedAt = receivedAt;
    row.preparationDeadline = preparationDeadline(run.checkedAt, receivedAt);
    row.summary = summarizeRoutineRun(run, !!this.state.scanId);
    row.status = run.coverage.complete ? "successful" : "partial";
    delete row.error;
  }

  stopAfterCurrent() {
    if (!this.active() || this.disposed) return;
    this.stopRequested = true;
    this.state.status = "stopping";
    this.emit();
  }

  /** A report change ends this generation and clears its report-bound evidence. */
  setContext(scanId?: string) {
    if (this.disposed || scanId === this.state.scanId) return;
    this.state.generation++;
    this.stopRequested = true;
    this.state.scanId = scanId;
    this.state.status = "idle";
    this.state.rows = this.initialRows(this.state.catalog, "not-run");
    delete this.state.refreshError;
    this.emit();
  }

  replaceCatalog(value: RoutineBatchCatalog) {
    if (this.active() || this.disposed) return false;
    const catalog = clone(value);
    const previous = new Map(
      this.state.rows.map((row) => [row.definition.id, row]),
    );
    this.state.catalog = catalog;
    this.state.rows = this.initialRows(catalog, "not-run").map((row) => {
      const old = previous.get(row.definition.id);
      return old && row.status !== "needs-settings"
        ? { ...old, definition: row.definition, preset: row.preset }
        : row;
    });
    this.emit();
    return true;
  }

  replaceResult(run: Run) {
    if (this.active() || this.disposed) return false;
    const row = this.state.rows.find(
      (item) => item.definition.id === run.routineId,
    );
    if (!row) return false;
    this.fillResult(row, run);
    this.emit();
    return true;
  }

  clearResult(routineId: string) {
    if (this.active() || this.disposed) return false;
    const index = this.state.rows.findIndex(
      (row) => row.definition.id === routineId,
    );
    if (index < 0) return false;
    this.state.rows[index] = this.initialRows(this.state.catalog, "not-run")[
      index
    ];
    this.emit();
    return true;
  }

  failResult(routineId: string, error: unknown) {
    if (!this.clearResult(routineId)) return false;
    const row = this.state.rows.find(
      (item) => item.definition.id === routineId,
    )!;
    row.status = "failed";
    row.error = errorMessage(error);
    this.emit();
    return true;
  }

  dispose() {
    this.disposed = true;
    this.stopRequested = true;
    this.state.generation++;
  }
}
