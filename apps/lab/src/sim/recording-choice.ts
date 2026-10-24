import { DEFAULT_RECORDING_PRESET, RECORDING_PRESETS, parseRecordingProfile, type RecordingPresetName, type RecordingProfile } from "@agentsim/trace";

// How the next run is recorded (ADR-0035 addition of 2026-10-17, items 2 and 6): the profile is chosen at launch, separately from the run
// configuration (a preset, or a profile as JSON), and "Don't record this run" is the researcher's explicit opt-out for that one run: never a
// default and never a fallback, so it is cleared the moment a run takes it.

/** How a run is recorded: with a recording profile, or not at all (the explicit opt-out). */
export type RecordingChoice = { readonly mode: "stored"; readonly profile: RecordingProfile } | { readonly mode: "none" };

export interface RecordingSelection {
  /** A preset by name, or `custom` (the JSON text below). */
  readonly preset: RecordingPresetName | "custom";
  readonly customJson: string;
  /** The opt-out for the next run only. */
  readonly optOut: boolean;
  /** How long the next headless run runs, in sim seconds (its end condition). */
  readonly headlessUntilS: number;
}

export const DEFAULT_RECORDING: RecordingChoice = { mode: "stored", profile: RECORDING_PRESETS[DEFAULT_RECORDING_PRESET] };

export const DEFAULT_HEADLESS_UNTIL_S = 60;
const INITIAL: RecordingSelection = { preset: DEFAULT_RECORDING_PRESET, customJson: JSON.stringify(RECORDING_PRESETS[DEFAULT_RECORDING_PRESET], null, 2), optOut: false, headlessUntilS: DEFAULT_HEADLESS_UNTIL_S };

let selection: RecordingSelection = INITIAL;
const listeners = new Set<() => void>();

export function getRecordingSelection(): RecordingSelection {
  return selection;
}

export function setRecordingSelection(patch: Partial<RecordingSelection>): void {
  selection = { ...selection, ...patch };
  for (const l of listeners) l();
}

export function subscribeRecordingSelection(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The selection's profile, or why it is not one (the control shows it before the run starts). */
export function profileOfSelection(s: RecordingSelection): { ok: true; profile: RecordingProfile } | { ok: false; message: string } {
  if (s.preset !== "custom") return { ok: true, profile: RECORDING_PRESETS[s.preset] };
  const r = parseRecordingProfile(s.customJson);
  return r.ok ? { ok: true, profile: r.value } : { ok: false, message: r.error.message };
}

/** Presets that write a lot (every pose at a high rate, everything at its fullest): a realtime run with one may fall behind its writer. */
export function isHeavyProfile(p: RecordingProfile): boolean {
  return p.channels.poses.rateHz > 5 || p.channels.metrics.rateHz > 5 || p.channels.transitions.level === "full" && p.channels.sensors.level === "full";
}

/**
 * How a headless run is recorded and for how long: the selection's profile, never the opt-out (a headless run is always recorded, ADR-0035), which stays set for the next
 * live run; the end condition is the selection's duration. A custom profile that is not valid refuses the start with the reason.
 */
export function takeHeadlessChoice(): { readonly recording: RecordingChoice; readonly untilS: number } {
  const s = selection;
  const p = profileOfSelection(s);
  if (!p.ok) throw new Error(`invalid_recording_profile: ${p.message}`);
  const untilS = Number.isFinite(s.headlessUntilS) && s.headlessUntilS > 0 ? Math.min(86_400, s.headlessUntilS) : DEFAULT_HEADLESS_UNTIL_S;
  return { recording: { mode: "stored", profile: p.profile }, untilS };
}

/**
 * The choice for the run that is starting: the selection, and the one-shot opt-out is cleared (the next run is recorded again). A custom
 * profile that is not valid refuses the start with the reason, and clears nothing.
 */
export function takeRecordingChoice(): RecordingChoice {
  const s = selection;
  if (s.optOut) {
    setRecordingSelection({ optOut: false });
    return { mode: "none" };
  }
  const p = profileOfSelection(s);
  if (!p.ok) throw new Error(`invalid_recording_profile: ${p.message}`);
  return { mode: "stored", profile: p.profile };
}
