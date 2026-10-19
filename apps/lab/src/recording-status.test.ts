import { RECORDING_PRESETS, recordingProfileHash, type RunHeader } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { describeRecording } from "./recording-status.tsx";

// F3a M2: the recording in the status line (ADR-0035 addition of 2026-10-17, items 6 and 12).

const profile = RECORDING_PRESETS["default-research"];
const recorded: RunHeader = {
  runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running", runConfigHash: "ab12cd34",
  recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile),
};
const optedOut: RunHeader = { runId: "run-000002", schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "running", recording: "none" };
const at = (header: RunHeader, tick: number, persisted: number | undefined, state: "ok" | "storage_backpressure" | "storage_quota" = "ok") =>
  describeRecording({ header, tick, persisted: persisted === undefined ? undefined : { tick: persisted }, state, backlogRecords: 1234 });

describe("describeRecording", () => {
  it("names the profile with both hashes for a recorded run", () => {
    const t = at(recorded, 10, 10);
    expect(t.recorded).toBe(true);
    expect(t.label).toBe(`● recording default-research · profile ${recordingProfileHash(profile)} · config ab12cd34`);
  });

  it("says `○ not recorded`, glyph and text, for an opted-out run, with nothing about saving", () => {
    const t = at(optedOut, 500, undefined);
    expect(t).toEqual({ recorded: false, label: "○ not recorded", saved: undefined, waiting: undefined });
  });

  it("says how far the run is saved: not yet, saved with a head ahead, or saved with no gap", () => {
    expect(at(recorded, 0, undefined).saved).toBe("not saved yet");
    expect(at(recorded, 130, 120).saved).toBe("saved to tick 120 · head 130");
    expect(at(recorded, 130, 130).saved).toBe("saved to tick 130");
    expect(at(recorded, 120, 130).saved).toBe("saved to tick 130"); // never a negative gap
  });

  it("says why the run waits: the writer is behind, or the storage quota is near", () => {
    expect(at(recorded, 1, 1).waiting).toBeUndefined();
    expect(at(recorded, 1, 1, "storage_backpressure").waiting).toMatch(/waiting for storage \(1234 records not saved yet\)/);
    expect(at(recorded, 1, 1, "storage_quota").waiting).toMatch(/storage quota is near/);
  });
});
