import { RECORDING_PRESETS, recordingProfileHash } from "@agentsim/trace";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HEADLESS_UNTIL_S, getRecordingSelection, isHeavyProfile, profileOfSelection, setRecordingSelection, takeHeadlessChoice, takeRecordingChoice } from "./recording-choice.ts";

// F3a M2: how the next run is recorded (ADR-0035 addition of 2026-10-17, item 6).

beforeEach(() => setRecordingSelection({ preset: "default-research", optOut: false, headlessUntilS: DEFAULT_HEADLESS_UNTIL_S }));

describe("the recording choice at launch", () => {
  it("is recorded under default-research unless the researcher chose otherwise", () => {
    expect(takeRecordingChoice()).toEqual({ mode: "stored", profile: RECORDING_PRESETS["default-research"] });
    setRecordingSelection({ preset: "minimal" });
    expect(takeRecordingChoice()).toEqual({ mode: "stored", profile: RECORDING_PRESETS.minimal });
  });

  it("opts out for one run only: the run after it is recorded again", () => {
    setRecordingSelection({ optOut: true });
    expect(takeRecordingChoice()).toEqual({ mode: "none" });
    expect(getRecordingSelection().optOut).toBe(false);
    expect(takeRecordingChoice().mode).toBe("stored");
  });

  it("takes a profile typed as JSON, and refuses one that is not a profile, saying why, without clearing the opt-out", () => {
    const custom = { ...RECORDING_PRESETS.minimal, name: "mine" };
    setRecordingSelection({ preset: "custom", customJson: JSON.stringify(custom) });
    const c = takeRecordingChoice();
    expect(c.mode === "stored" && recordingProfileHash(c.profile)).toBe(recordingProfileHash(custom));
    setRecordingSelection({ customJson: "{not json" });
    expect(() => takeRecordingChoice()).toThrow(/invalid_recording_profile/);
    expect(profileOfSelection(getRecordingSelection()).ok).toBe(false);
    setRecordingSelection({ optOut: true });
    expect(takeRecordingChoice()).toEqual({ mode: "none" }); // an opt-out does not need a valid profile
  });

  it("calls a profile heavy when it samples fast or records everything at its fullest", () => {
    expect(isHeavyProfile(RECORDING_PRESETS["default-research"])).toBe(false);
    expect(isHeavyProfile(RECORDING_PRESETS.minimal)).toBe(false);
    expect(isHeavyProfile(RECORDING_PRESETS["debug-full"])).toBe(true);
  });
});

describe("the choice of a headless run (ADR-0029, ADR-0035: always recorded)", () => {
  it("takes the selection's profile and its duration, and never the opt-out: that stays set for the next live run", () => {
    setRecordingSelection({ preset: "minimal", optOut: true, headlessUntilS: 120 });
    const c = takeHeadlessChoice();
    expect(c).toEqual({ recording: { mode: "stored", profile: RECORDING_PRESETS.minimal }, untilS: 120 });
    expect(getRecordingSelection().optOut).toBe(true);
    expect(takeRecordingChoice()).toEqual({ mode: "none" }); // the live run still opts out, once
  });

  it("keeps the duration sane: the default for a number that is not one, at most a day", () => {
    setRecordingSelection({ headlessUntilS: Number.NaN });
    expect(takeHeadlessChoice().untilS).toBe(DEFAULT_HEADLESS_UNTIL_S);
    setRecordingSelection({ headlessUntilS: -5 });
    expect(takeHeadlessChoice().untilS).toBe(DEFAULT_HEADLESS_UNTIL_S);
    setRecordingSelection({ headlessUntilS: 1e9 });
    expect(takeHeadlessChoice().untilS).toBe(86_400);
  });

  it("refuses a profile that is not one, saying why", () => {
    setRecordingSelection({ preset: "custom", customJson: "{not json" });
    expect(() => takeHeadlessChoice()).toThrow(/invalid_recording_profile/);
  });
});
