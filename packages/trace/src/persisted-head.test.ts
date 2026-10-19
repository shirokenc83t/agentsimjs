import { describe, expect, it } from "vitest";
import { RunRecorder, gapOf, type PersistedHead, type RecorderBatch } from "./recorder.ts";
import { RECORDING_PRESETS } from "./recording-profile.ts";
import { TraceBuffer } from "./trace-buffer.ts";

// F3a M2: the sim head, the persisted head and the gap between them (ADR-0035 addition of 2026-10-17, item 12): no flush yet, a flush
// behind the sim head, backlog; the head only moves forward and only for its own run.

const emit = (buf: TraceBuffer, tick: number, n = 1) => {
  for (let i = 0; i < n; i++) buf.for("world/sim").append({ simTime: tick * 0.1, kind: "event", payload: { op: "x", tick, i } });
};

function setup(profile = RECORDING_PRESETS["default-research"], capacity = 1000) {
  const buf = new TraceBuffer("run-000001", () => 0, capacity);
  const sent: RecorderBatch[] = [];
  const rec = new RunRecorder({ buffer: buf, profile, send: (b) => sent.push(b) });
  return { buf, rec, sent };
}
const ack = (b: RecorderBatch): PersistedHead => ({ runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS });

describe("gapOf", () => {
  it("is the whole run before any flush, the difference after one, and nothing when saved", () => {
    expect(gapOf({ tick: 7, simTimeS: 0.7 }, undefined)).toEqual({ state: "none-yet", ticks: 7, simTimeS: 0.7 });
    expect(gapOf({ tick: 7, simTimeS: 0.7 }, { tick: 5, simTimeS: 0.5 })).toMatchObject({ state: "behind", ticks: 2 });
    expect(gapOf({ tick: 7, simTimeS: 0.7 }, { tick: 7, simTimeS: 0.7 })).toEqual({ state: "saved", ticks: 0, simTimeS: 0 });
    expect(gapOf({ tick: 7, simTimeS: 0.7 }, { tick: 9, simTimeS: 0.9 }).state).toBe("saved"); // never negative
  });
});

describe("a recorder's heads", () => {
  it("reports no flush yet, then a flush behind the sim head, then none behind", () => {
    const { buf, rec, sent } = setup();
    rec.headerStored();
    expect(gapOf(rec.simHead, rec.persistedHead)).toEqual({ state: "none-yet", ticks: 0, simTimeS: 0 });
    emit(buf, 1, 2);
    rec.collect(1, 0.1);
    emit(buf, 2, 2);
    rec.collect(2, 0.2);
    emit(buf, 3, 2);
    rec.collect(3, 0.3);
    expect(gapOf(rec.simHead, rec.persistedHead)).toEqual({ state: "none-yet", ticks: 3, simTimeS: 0.3 });
    rec.persisted(ack(sent[0] as RecorderBatch));
    expect(gapOf(rec.simHead, rec.persistedHead)).toMatchObject({ state: "behind", ticks: 2 });
    expect(gapOf(rec.simHead, rec.persistedHead).simTimeS).toBeCloseTo(0.2, 9);
    sent.slice(1).forEach((b) => rec.persisted(ack(b)));
    expect(gapOf(rec.simHead, rec.persistedHead)).toEqual({ state: "saved", ticks: 0, simTimeS: 0 });
  });

  it("frees the cache as the head advances and counts the backlog in records", () => {
    const { buf, rec, sent } = setup(RECORDING_PRESETS["default-research"], 3);
    rec.headerStored();
    for (let t = 1; t <= 5; t++) {
      emit(buf, t, 4);
      rec.collect(t, t * 0.1);
    }
    expect(buf.all()).toHaveLength(20);
    expect(rec.backlogRecords).toBe(20);
    rec.persisted(ack(sent[2] as RecorderBatch));
    expect(rec.backlogRecords).toBe(8);
    expect(buf.all().map((r) => r.seq)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]); // the persisted ones went; capacity 3 does not drop what is not saved
    sent.slice(3).forEach((b) => rec.persisted(ack(b)));
    expect(rec.backlogRecords).toBe(0);
    expect(buf.all()).toHaveLength(3);
  });

  it("ignores an acknowledgement of another run and one that goes back", () => {
    const { buf, rec, sent } = setup();
    rec.headerStored();
    emit(buf, 1, 1);
    rec.collect(1, 0.1);
    emit(buf, 2, 1);
    rec.collect(2, 0.2);
    rec.persisted({ runId: "run-000009", throughSeq: 1, tick: 2, simTimeS: 0.2 });
    expect(rec.persistedHead).toBeUndefined();
    rec.persisted(ack(sent[1] as RecorderBatch));
    rec.persisted(ack(sent[0] as RecorderBatch));
    expect(rec.persistedHead?.tick).toBe(2);
  });
});

