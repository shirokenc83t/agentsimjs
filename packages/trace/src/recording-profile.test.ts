import { validate } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_PRESET,
  RECORDING_PRESETS,
  RECORDING_PROFILE_MAX_BYTES,
  RecordingProfile,
  parseRecordingProfile,
  recordingProfileHash,
} from "./recording-profile.ts";

// F3a M2: the recording profile document (ADR-0035 §1 and §2, addition of 2026-10-17, items 1 and 9).

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T,>(p: T): T => JSON.parse(JSON.stringify(p)) as T;
/** A copy of default-research with a change made to it. */
const mutate = (f: (p: Doc) => void): unknown => {
  const p = clone(RECORDING_PRESETS["default-research"]) as unknown as Doc;
  f(p);
  return p;
};
const accepts = (v: unknown): boolean => validate(RecordingProfile, v).ok;

describe("recording profile presets", () => {
  it("has the three presets, each a valid document named after itself, and default-research is the default", () => {
    expect(Object.keys(RECORDING_PRESETS).sort()).toEqual(["debug-full", "default-research", "minimal"]);
    expect(DEFAULT_RECORDING_PRESET).toBe("default-research");
    for (const [name, p] of Object.entries(RECORDING_PRESETS)) {
      expect(accepts(p), name).toBe(true);
      expect(p.name).toBe(name);
    }
  });

  it("default-research has the defaults of the ADR: checkpoint every 100 ticks, snapshot every 60 s, poses at 2 Hz, beliefs as chunks, compute per stage", () => {
    const p = RECORDING_PRESETS["default-research"];
    expect(p.checkpoints).toEqual({ everyTicks: 100, snapshotEveryS: 60 });
    expect(p.channels.poses.rateHz).toBe(2);
    expect(p.channels.beliefs.level).toBe("chunks");
    expect(p.channels.compute.level).toBe("per-stage");
    expect(p.channels["mind-io"].level).toBe("full");
    expect(p.channels.metrics.rateHz).toBe(1);
    expect(p.channels.health.rateHz).toBe(1);
    expect(p.channels.sensors.level).toBe("off");
  });

  it("minimal turns beliefs off and keeps compute at summary and mind-io at metadata", () => {
    const p = RECORDING_PRESETS.minimal;
    expect(p.channels.beliefs.level).toBe("off");
    expect(p.channels.compute.level).toBe("summary");
    expect(p.channels["mind-io"].level).toBe("metadata");
  });

  it("debug-full records everything the simulator can produce at its fullest", () => {
    const p = RECORDING_PRESETS["debug-full"];
    expect(p.channels.transitions.level).toBe("full");
    expect(p.channels.compute.level).toBe("per-stage");
    expect(p.channels["mind-io"].level).toBe("full");
    expect(p.channels.beliefs.level).toBe("chunks");
    expect(p.channels.poses.rateHz).toBeGreaterThan(RECORDING_PRESETS["default-research"].channels.poses.rateHz);
  });
});

describe("recording profile validation", () => {
  it("rejects unknown fields at every level (strict)", () => {
    expect(accepts(mutate((p) => (p.extra = 1)))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.extra = {})))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.events.extra = 1)))).toBe(false);
    expect(accepts(mutate((p) => (p.checkpoints.extra = 1)))).toBe(false);
  });

  it("lets the metrics channel be off (it is observer data, outside the tracing rule); the presets leave it on by not saying so, which is what keeps their hashes", () => {
    for (const [name, p] of Object.entries(RECORDING_PRESETS)) expect(p.channels.metrics, name).not.toHaveProperty("level");
    const off = mutate((p) => (p["channels"]["metrics"]["level"] = "off"));
    expect(accepts(off)).toBe(true);
    expect(accepts(mutate((p) => (p["channels"]["metrics"]["level"] = "on")))).toBe(true);
    expect(accepts(mutate((p) => (p["channels"]["metrics"]["level"] = "sampled")))).toBe(false);
    expect(recordingProfileHash(off as typeof RECORDING_PRESETS.minimal)).not.toBe(recordingProfileHash(RECORDING_PRESETS["default-research"]));
    // The channels the tracing rule requires still have no off.
    expect(accepts(mutate((p) => (p["channels"]["events"]["level"] = "off")))).toBe(false);
  });

  it("does not let the required channels be switched off or lowered: events, transitions, compute, mind-io", () => {
    expect(accepts(mutate((p) => (p.channels.events.level = "off")))).toBe(false);
    expect(accepts(mutate((p) => delete p.channels.events))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.transitions.level = "off")))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.compute.level = "off")))).toBe(false);
    expect(accepts(mutate((p) => (p.channels["mind-io"].level = "off")))).toBe(false);
  });

  it("limits the rates, the intervals and the per-kind pose overrides", () => {
    for (const bad of [0, 0.09, 20.5, Number.NaN, -1]) expect(accepts(mutate((p) => (p.channels.poses.rateHz = bad))), `rate ${bad}`).toBe(false);
    for (const good of [0.1, 2, 20]) expect(accepts(mutate((p) => (p.channels.poses.rateHz = good)))).toBe(true);
    expect(accepts(mutate((p) => (p.channels.poses.perKindRateHz = { uav: 10, ugv: 0.5 })))).toBe(true);
    expect(accepts(mutate((p) => (p.channels.poses.perKindRateHz = { uav: 30 })))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.poses.perKindRateHz = { drone: 5 })))).toBe(false);
    expect(accepts(mutate((p) => (p.checkpoints.everyTicks = 0)))).toBe(false);
    expect(accepts(mutate((p) => (p.checkpoints.everyTicks = 1.5)))).toBe(false);
    expect(accepts(mutate((p) => (p.checkpoints.snapshotEveryS = 0.5)))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.beliefs.keyframeEveryS = 0)))).toBe(false);
    expect(accepts(mutate((p) => (p.channels.metrics.rateHz = 100)))).toBe(false);
  });

  it("parses strict JSON text, with a size limit, and says why it refuses", () => {
    const ok = parseRecordingProfile(JSON.stringify(RECORDING_PRESETS.minimal));
    expect(ok.ok && ok.value).toEqual(RECORDING_PRESETS.minimal);
    const notJson = parseRecordingProfile("{nope");
    expect(!notJson.ok && notJson.error.code).toBe("invalid_recording_profile");
    const wrong = parseRecordingProfile(JSON.stringify({ ...RECORDING_PRESETS.minimal, schemaVersion: 1 }));
    expect(!wrong.ok && wrong.error.code).toBe("invalid_recording_profile");
    const big = parseRecordingProfile(JSON.stringify({ ...RECORDING_PRESETS.minimal, name: "x".repeat(RECORDING_PROFILE_MAX_BYTES) }));
    expect(!big.ok && big.error.message).toMatch(/too large/);
  });
});

describe("recording profile hash", () => {
  it("is 8 hex digits, the same whatever the key order, and differs between presets and for any changed field", () => {
    const base = RECORDING_PRESETS["default-research"];
    const h = recordingProfileHash(base);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    const reversed = Object.fromEntries(Object.entries(base).reverse()) as unknown as typeof base;
    expect(recordingProfileHash(reversed)).toBe(h);
    expect(new Set(Object.values(RECORDING_PRESETS).map(recordingProfileHash)).size).toBe(3);
    const changed = clone(base);
    (changed.checkpoints as { everyTicks: number }).everyTicks = 101;
    expect(recordingProfileHash(changed)).not.toBe(h);
  });

  it("is pinned for the presets, so a change of a preset is noticed and decided (runs record this hash)", () => {
    expect(Object.fromEntries(Object.entries(RECORDING_PRESETS).map(([n, p]) => [n, recordingProfileHash(p)]))).toEqual(PRESET_HASHES);
  });
});

const PRESET_HASHES: Record<string, string> = { minimal: "60b7598a", "default-research": "19cfa400", "debug-full": "99ed1697" };
