import { contentHash, err, ok, validate, type CodedError, type Result } from "@agentsim/core";
import Type, { type Static } from "typebox";

// The recording profile (ADR-0035 §1 and §2, addition of 2026-10-17, items 1 and 9): the level or rate of each channel and the
// checkpoint, snapshot and belief keyframe intervals. A profile is chosen at launch, separately from the run configuration, and is
// immutable for the run; it changes the detail of what is recorded and never what happens in the simulation.

export const RECORDING_PROFILE_SCHEMA_VERSION = 0;
export const RECORDING_PROFILE_MAX_BYTES = 16 * 1024;

const strict = { additionalProperties: false } as const;
const RateHz = Type.Number({ minimum: 0.1, maximum: 20 });

/**
 * The channels of ADR-0035 §1. A channel that the tracing rule requires has no `off` and no level below the one it must keep:
 * `events` is always full, `transitions` cannot be switched off, `compute` has no level below `summary` (still one record per
 * query), `mind-io` none below `metadata`.
 */
export const RecordingChannels = Type.Object(
  {
    events: Type.Object({ level: Type.Literal("full") }, strict),
    transitions: Type.Object({ level: Type.Union([Type.Literal("transitions"), Type.Literal("full")]) }, strict),
    protocol: Type.Object({ level: Type.Literal("full") }, strict),
    compute: Type.Object({ level: Type.Union([Type.Literal("summary"), Type.Literal("per-stage")]) }, strict),
    "mind-io": Type.Object({ level: Type.Union([Type.Literal("metadata"), Type.Literal("full")]) }, strict),
    poses: Type.Object(
      {
        rateHz: RateHz,
        /** A rate for the agents of one kind, over `rateHz`. */
        perKindRateHz: Type.Optional(Type.Object({ uav: Type.Optional(RateHz), ugv: Type.Optional(RateHz), ev: Type.Optional(RateHz) }, strict)),
      },
      strict,
    ),
    beliefs: Type.Object(
      {
        level: Type.Union([Type.Literal("off"), Type.Literal("diffs"), Type.Literal("chunks")]),
        /** K: sim seconds between belief keyframes (a placeholder until the F3a M2 measurement). */
        keyframeEveryS: Type.Number({ minimum: 1, maximum: 3600 }),
      },
      strict,
    ),
    /** Observer data, outside the tracing rule: it may be off (`level: "off"`). Absent means on, so the presets (which do not carry it) keep their hashes. */
    metrics: Type.Object({ rateHz: RateHz, level: Type.Optional(Type.Union([Type.Literal("on"), Type.Literal("off")])) }, strict),
    health: Type.Object({ rateHz: RateHz }, strict),
    sensors: Type.Object({ level: Type.Union([Type.Literal("off"), Type.Literal("decimated"), Type.Literal("full")]) }, strict),
  },
  strict,
);

export const RecordingProfile = Type.Object(
  {
    schemaVersion: Type.Literal(RECORDING_PROFILE_SCHEMA_VERSION),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    channels: RecordingChannels,
    checkpoints: Type.Object(
      {
        /** N: ticks between checkpoint records (state hash). */
        everyTicks: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        /** S: sim seconds between periodic snapshots (start and end are always taken). */
        snapshotEveryS: Type.Number({ minimum: 1, maximum: 86_400 }),
      },
      strict,
    ),
  },
  strict,
);
export type RecordingProfile = Static<typeof RecordingProfile>;

export type RecordingPresetName = "minimal" | "default-research" | "debug-full";

const defaultResearch: RecordingProfile = {
  schemaVersion: 0,
  name: "default-research",
  channels: {
    events: { level: "full" },
    transitions: { level: "transitions" },
    protocol: { level: "full" },
    compute: { level: "per-stage" },
    "mind-io": { level: "full" },
    poses: { rateHz: 2 },
    beliefs: { level: "chunks", keyframeEveryS: 30 },
    metrics: { rateHz: 1 },
    health: { rateHz: 1 },
    sensors: { level: "off" },
  },
  checkpoints: { everyTicks: 100, snapshotEveryS: 60 },
};

export const RECORDING_PRESETS: Readonly<Record<RecordingPresetName, RecordingProfile>> = {
  minimal: {
    ...defaultResearch,
    name: "minimal",
    channels: { ...defaultResearch.channels, compute: { level: "summary" }, "mind-io": { level: "metadata" }, beliefs: { level: "off", keyframeEveryS: 30 } },
  },
  "default-research": defaultResearch,
  "debug-full": {
    ...defaultResearch,
    name: "debug-full",
    channels: {
      ...defaultResearch.channels,
      transitions: { level: "full" },
      poses: { rateHz: 10 },
      metrics: { rateHz: 10 },
      health: { rateHz: 10 },
      sensors: { level: "full" },
    },
  },
};

export const DEFAULT_RECORDING_PRESET: RecordingPresetName = "default-research";

export type RecordingProfileError = CodedError<"invalid_recording_profile">;

/** Reads a profile from JSON text (untrusted: typed by the researcher or read from a library export). */
export function parseRecordingProfile(text: string): Result<RecordingProfile, RecordingProfileError> {
  const bad = (message: string) => err({ code: "invalid_recording_profile" as const, message });
  if (text.length > RECORDING_PROFILE_MAX_BYTES) return bad(`recording profile too large (more than ${RECORDING_PROFILE_MAX_BYTES} characters)`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad("recording profile is not valid JSON");
  }
  const checked = validate(RecordingProfile, value);
  if (!checked.ok) return bad(`${checked.error.issues[0]?.path || "/"}: ${checked.error.message}`);
  return ok(checked.value);
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sorted(x);
    }
    return out;
  }
  return v;
}

/**
 * The run header's `recordingProfileHash`: the content hash of the canonical document (keys sorted, no whitespace), as for the
 * run configuration's hash, 8 hex digits.
 */
export function recordingProfileHash(p: RecordingProfile): string {
  return contentHash(JSON.stringify(sorted(p)));
}
