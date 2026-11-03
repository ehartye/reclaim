import { normalizeRoots } from "./project-discovery.mjs";
import { getRoutineDefinition } from "./routine-policies.mjs";
import { ROUTINE_MAXIMUM_BYTES } from "../shared/routines.ts";

const keys = new Set([
  "routineId",
  "policyVersion",
  "minimumBytes",
  "minimumAgeDays",
  "roots",
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function defaultRoutinePreset(routineId, roots = []) {
  const definition = getRoutineDefinition(routineId);
  return {
    routineId,
    policyVersion: definition.policyVersion,
    ...definition.defaults,
    roots: definition.scope === "project" ? normalizeRoots(roots) : [],
  };
}
export function validateRoutinePreset(input, { roots = [] } = {}) {
  if (!object(input) || Object.keys(input).some((key) => !keys.has(key)))
    throw new Error(
      "Use only routine parameters; paths, commands and executable arguments are not accepted.",
    );
  const definition = getRoutineDefinition(input.routineId);
  const preset = { ...defaultRoutinePreset(definition.id, roots), ...input };
  if (preset.policyVersion !== definition.policyVersion)
    throw new Error(
      "Routine policy changed. Review and save the preset again.",
    );
  if (
    !Number.isSafeInteger(preset.minimumBytes) ||
    preset.minimumBytes < 0 ||
    preset.minimumBytes > ROUTINE_MAXIMUM_BYTES
  )
    throw new Error("Enter a valid minimum size in bytes.");
  if (
    preset.minimumAgeDays !== null &&
    (!Number.isSafeInteger(preset.minimumAgeDays) ||
      preset.minimumAgeDays < 0 ||
      preset.minimumAgeDays > 36500)
  )
    throw new Error("Use an age hint from 0 to 36500 days, or turn it off.");
  if (preset.minimumAgeDays !== null && !definition.supportsAgeHint)
    throw new Error(
      "This managed routine does not support an age eligibility filter.",
    );
  if (
    definition.scope !== "project" &&
    (!Array.isArray(preset.roots) || preset.roots.length)
  )
    throw new Error(
      "Managed cache locations must be resolved by their owner, not submitted as project roots.",
    );
  return {
    routineId: definition.id,
    policyVersion: definition.policyVersion,
    minimumBytes: preset.minimumBytes,
    minimumAgeDays: preset.minimumAgeDays,
    roots: normalizeRoots(preset.roots),
  };
}
// Load only the dedicated routine state, never legacy planner age/MiB settings.
// Rejected known parameters survive for display/correction, but cannot run.
export function loadRoutinePresets(stored) {
  if (stored === undefined || stored === null)
    return { schemaVersion: 1, presets: {}, invalidPresets: {} };
  if (
    !object(stored) ||
    stored.schemaVersion !== 1 ||
    !object(stored.presets) ||
    (stored.invalidPresets !== undefined && !object(stored.invalidPresets))
  )
    throw new Error(
      "Unsupported routine preset state. Preserve it before migrating.",
    );
  const state = { schemaVersion: 1, presets: {}, invalidPresets: {} };
  const entries = { ...stored.invalidPresets, ...stored.presets };
  for (const [id, raw] of Object.entries(entries)) {
    const parameters =
      object(raw) && object(raw.parameters) ? raw.parameters : raw;
    try {
      if (!Object.hasOwn(stored.presets, id))
        throw new Error(
          typeof raw?.error === "string"
            ? raw.error.slice(0, 1000)
            : "Review and save this invalid preset again.",
        );
      if (!object(parameters) || parameters.routineId !== id)
        throw new Error("Stored routine identity does not match its key.");
      state.presets[id] = validateRoutinePreset(parameters);
    } catch (error) {
      const retained = {};
      if (object(parameters))
        for (const key of keys)
          if (Object.hasOwn(parameters, key)) retained[key] = parameters[key];
      Object.defineProperty(state.invalidPresets, id, {
        value: { parameters: retained, error: error.message },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return state;
}
export function saveRoutinePreset(state, input, defaults) {
  const loaded = loadRoutinePresets(state);
  const preset = validateRoutinePreset(input, defaults);
  return {
    ...loaded,
    presets: { ...loaded.presets, [preset.routineId]: preset },
    invalidPresets: Object.fromEntries(
      Object.entries(loaded.invalidPresets).filter(
        ([id]) => id !== preset.routineId,
      ),
    ),
  };
}
