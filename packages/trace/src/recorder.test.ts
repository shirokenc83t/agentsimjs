import { describe, expect, it } from "vitest";
import { RunRecorder, gapOf, type PersistedHead, type RecorderBatch } from "./recorder.ts";
import { RECORDING_PRESETS } from "./recording-profile.ts";
import { TraceBuffer } from "./trace-buffer.ts";

// F3a M2: the recorder at the producer (ADR-0035 addition of 2026-10-17, items 6 and 12): it applies the profile, holds what is
// emitted before the run header is stored, hands batches to the storage worker and tracks the sim head, the persisted head and the gap.

const emit = (buf: TraceBuffer, tick: number, n = 1, extra: { source?: string; kind?: "event" | "thought"; payload?: unknown } = {}) => {
  for (let i = 0; i < n; i++) buf.for((extra.source ?? "world/sim") as "world/sim").append({ simTime: tick * 0.1, kind: extra.kind ?? "event", payload: extra.payload ?? { op: "x", tick, i } });
};

function setup(profile = RECORDING_PRESETS["default-research"], capacity = 1000) {
  const buf = new TraceBuffer("run-000001", () => 0, capacity);
  const sent: RecorderBatch[] = [];
  const rec = new RunRecorder({ buffer: buf, profile, send: (b) => sent.push(b) });
  return { buf, rec, sent };
}
const ack = (b: RecorderBatch): PersistedHead => ({ runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS });

describe("RunRecorder: header first", () => {
  it("sends nothing until the run header is stored, then everything emitted before it, in order, in one batch", () => {
    const { buf, rec, sent } = setup();
    emit(buf, 0, 3); // genesis: start events, first requests, config records
    expect(rec.awaitingHeader).toBe(true);
    rec.collect(0, 0);
    expect(sent).toEqual([]);
    emit(buf, 1, 2);
    rec.collect(1, 0.1);
    expect(sent).toEqual([]);
    rec.headerStored();
    expect(rec.awaitingHeader).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect([sent[0]?.tick, sent[0]?.simTimeS, sent[0]?.throughSeq, sent[0]?.runId]).toEqual([1, 0.1, 4, "run-000001"]);
    emit(buf, 2, 1);
    rec.collect(2, 0.2);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.records.map((r) => r.seq)).toEqual([5]);
  });

  it("keeps the unsent records in the cache however small its capacity", () => {
    const { buf, rec } = setup(RECORDING_PRESETS["default-research"], 4);
    emit(buf, 0, 20);
    rec.collect(0, 0);
    expect(buf.all()).toHaveLength(20);
  });
});

describe("RunRecorder: batches", () => {
  it("hands one batch per collection with the records since the last, whole and in order", () => {
    const { buf, rec, sent } = setup();
    rec.headerStored();
    for (let t = 1; t <= 4; t++) {
      emit(buf, t, t);
      rec.collect(t, t * 0.1);
    }
    expect(sent.map((b) => b.records.length)).toEqual([1, 2, 3, 4]);
    expect(sent.flatMap((b) => b.records.map((r) => r.seq))).toEqual([...Array(10).keys()]);
    expect(sent.map((b) => b.tick)).toEqual([1, 2, 3, 4]);
  });

  it("applies the profile to what it sends: minimal drops the observer's samples, and the throughSeq still covers them", () => {
    const { buf, rec, sent } = setup(RECORDING_PRESETS.minimal);
    rec.headerStored();
    emit(buf, 1, 1, { payload: { op: "belief-vs-truth", observer: true, entities: [] } });
    emit(buf, 1, 1, { payload: { op: "timer-set" } });
    emit(buf, 1, 1, { payload: { op: "belief-vs-truth", observer: true, entities: [] } });
    rec.collect(1, 0.1);
    expect(sent[0]?.records.map((r) => r.seq)).toEqual([1]);
    expect(sent[0]?.throughSeq).toBe(2);
  });

  it("redacts a planted key before a record leaves, under every preset", () => {
    for (const profile of Object.values(RECORDING_PRESETS)) {
      const { buf, rec, sent } = setup(profile);
      rec.headerStored();
      emit(buf, 1, 1, { kind: "thought", payload: { op: "decision", params: { apiKey: "sk-ant-PLANTED0123456789abcdef" } } });
      rec.collect(1, 0.1);
      expect(JSON.stringify(sent)).not.toContain("PLANTED");
      expect(sent[0]?.records).toHaveLength(1);
    }
  });

  it("sends a batch with no records only while a flush is outstanding, otherwise it moves the persisted head itself", () => {
    const { buf, rec, sent } = setup();
    rec.headerStored();
    emit(buf, 1, 1);
    rec.collect(1, 0.1);
    rec.collect(2, 0.2); // nothing new, a batch in flight: the head of the batch queue moves on
    expect(sent).toHaveLength(2);
    expect(sent[1]?.records).toEqual([]);
    sent.forEach((b) => rec.persisted(ack(b)));
    rec.collect(3, 0.3); // nothing new, nothing in flight: nothing to send; everything up to tick 3 is saved
    expect(sent).toHaveLength(2);
    expect(rec.persistedHead).toMatchObject({ tick: 3, simTimeS: 0.3, throughSeq: 0 });
  });
});

describe("RunRecorder: sim head, persisted head, gap", () => {
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

describe("RunRecorder: the panel stream", () => {
  it("is fed from what the recorder collects (profile applied), once, in order, whether or not the header is stored", () => {
    const { buf, rec } = setup(RECORDING_PRESETS.minimal);
    emit(buf, 0, 2);
    emit(buf, 0, 1, { payload: { op: "belief-vs-truth", observer: true, entities: [] } });
    rec.collect(0, 0);
    expect(rec.takePanel().map((r) => r.seq)).toEqual([0, 1]);
    expect(rec.takePanel()).toEqual([]);
    rec.headerStored();
    emit(buf, 1, 1);
    rec.collect(1, 0.1);
    expect(rec.takePanel().map((r) => r.seq)).toEqual([3]);
  });

  it("loses no record to the cache's capacity between two reads of the panel", () => {
    const { buf, rec } = setup(RECORDING_PRESETS["default-research"], 5);
    rec.headerStored();
    for (let t = 1; t <= 10; t++) {
      emit(buf, t, 10);
      rec.collect(t, t * 0.1);
    }
    expect(rec.takePanel()).toHaveLength(100);
  });
});
