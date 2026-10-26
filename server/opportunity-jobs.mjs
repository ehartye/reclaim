import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { measureFolder } from "./folder-measurement.mjs";
import { withoutOverlappingTargets } from "../shared/opportunities.ts";
export async function createMeasurementJobs({ dataDir }) {
  const directory = path.join(dataDir, "intelligence"),
    file = path.join(directory, "measurements.json");
  let measurements = {},
    active = null,
    lastError = "",
    closed = false;
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (
      saved.version === 1 &&
      saved.measurements &&
      typeof saved.measurements === "object"
    )
      for (const [id, m] of Object.entries(saved.measurements))
        if (
          m &&
          typeof m.path === "string" &&
          path.isAbsolute(m.path) &&
          ["complete", "partial", "cancelled"].includes(m.status) &&
          Number.isFinite(Date.parse(m.measuredAt))
        )
          measurements[id] = m;
  } catch (e) {
    if (e.code !== "ENOENT")
      lastError =
        "Cached measurements could not be loaded. Re-measure targets: " +
        e.message;
  }
  const save = async () => {
    await mkdir(directory, { recursive: true });
    measurements = Object.fromEntries(
      Object.entries(measurements)
        .sort(
          (a, b) => Date.parse(b[1].measuredAt) - Date.parse(a[1].measuredAt),
        )
        .slice(0, 1000),
    );
    const temporary = file + ".tmp";
    await writeFile(temporary, JSON.stringify({ version: 1, measurements }));
    await rename(temporary, file);
  };
  const api = {
    getSnapshot() {
      return {
        measurements,
        job: active
          ? {
              id: active.id,
              total: active.total,
              done: active.done,
              path: active.path,
              progress: active.progress,
            }
          : null,
        error: lastError || undefined,
      };
    },
    start(targets) {
      if (closed) throw new Error("Measurement service is closed.");
      if (active)
        throw Object.assign(new Error("A measurement is already running."), {
          status: 409,
        });
      if (
        !Array.isArray(targets) ||
        !targets.length ||
        targets.length > 20 ||
        targets.some(
          (t) => typeof t.id !== "string" || !path.isAbsolute(t.path),
        )
      )
        throw new Error("Choose one to twenty known folder targets.");
      targets = withoutOverlappingTargets([
        ...new Map(targets.map((t) => [t.id, t])).values(),
      ]);
      const current = {
        id: randomUUID(),
        total: targets.length,
        done: 0,
        path: "",
        progress: null,
        controller: new AbortController(),
        promise: null,
      };
      active = current;
      lastError = "";
      current.promise = (async () => {
        try {
          for (const target of targets) {
            current.path = target.path;
            current.progress = null;
            let result;
            try {
              result = await measureFolder({
                path: target.path,
                signal: current.controller.signal,
                timeoutMs: 60000,
                onProgress: (progress) => {
                  current.progress = progress;
                },
              });
            } catch (e) {
              result = {
                path: target.path,
                measuredAt: new Date().toISOString(),
                status: current.controller.signal.aborted
                  ? "cancelled"
                  : "partial",
                logicalBytes: 0,
                allocatedBytes: null,
                exclusiveAllocatedBytes: null,
                sharedAllocatedBytes: null,
                fileCount: 0,
                newestActivityAt: null,
                skippedCount: 0,
                errorCount: 1,
                notices: [e.message],
                basis: "logical-only",
              };
            }
            measurements[target.id] = result;
            current.done++;
            await save();
            if (current.controller.signal.aborted) break;
          }
        } catch (e) {
          lastError = "Measurement results could not be saved: " + e.message;
        } finally {
          active = null;
        }
      })();
      return { id: current.id, total: current.total };
    },
    cancel() {
      active?.controller.abort();
    },
    async wait() {
      await active?.promise;
    },
    async close() {
      closed = true;
      active?.controller.abort();
      await active?.promise;
    },
  };
  return api;
}
