import { describe, expect, it } from "vitest";
import { DEFAULT_FLOW_CONTROL, RunRecorder, estimateRecordBytes, type FlowControl, type PersistedHead, type RecorderBatch } from "./recorder.ts";
import { RECORDING_PRESETS } from "./recording-profile.ts";
import { TraceBuffer } from "./trace-buffer.ts";

// F3a M2: flow control at the producer (ADR-0035 §6; ADR-0013 addition of 2026-10-17): the backlog of records not yet saved has a high-water
// and a low-water mark; above the high mark the run waits at the end of the tick, and goes on when the backlog is at or below the low mark.

const emit = (buf: TraceBuffer, tick: number, n: number, payload: unknown = { op: "x" }) => {
  for (let i = 0; i < n; i++) buf.for("world/sim").append({ simTime: tick * 0.1, kind: "event", payload });
};
const small: FlowControl = { highRecords: 10, lowRecords: 4, highBytes: 1_000_000, lowBytes: 500_000 };

function setup(flow: FlowControl = small) {
  const buf = new TraceBuffer("run-000001", () => 0, 1000);
  const sent: RecorderBatch[] = [];
  const rec = new RunRecorder({ buffer: buf, profile: RECORDING_PRESETS["default-research"], send: (b) => sent.push(b), flow });
  rec.headerStored();
  return { buf, rec, sent };
}
const ack = (b: RecorderBatch): PersistedHead => ({ runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS });

describe("flow control marks", () => {
  it("starts at the values of the plan: 50,000 records or 32 MiB, and half of it", () => {
    expect(DEFAULT_FLOW_CONTROL).toEqual({ highRecords: 50_000, lowRecords: 25_000, highBytes: 32 * 1024 * 1024, lowBytes: 16 * 1024 * 1024 });
  });

  it("estimates a record's size from its payload, never less than a fixed overhead", () => {
    const empty = { id: "a", runId: "r", seq: 0, simTime: 0, wallTime: 0, source: "world/sim", kind: "event", payload: null } as const;
    expect(estimateRecordBytes(empty)).toBeGreaterThan(100);
    expect(estimateRecordBytes({ ...empty, payload: { text: "x".repeat(1000) } })).toBeGreaterThan(estimateRecordBytes(empty) + 1000);
  });
});

describe("RunRecorder: backpressure", () => {
  it("does not wait below the high mark, waits at or above it, and goes on at or below the low mark (not before)", () => {
    const { buf, rec, sent } = setup();
    emit(buf, 1, 6);
    rec.collect(1, 0.1);
    expect(rec.backlog).toMatchObject({ records: 6 });
    expect(rec.waiting).toBe(false);
    emit(buf, 2, 4);
    rec.collect(2, 0.2);
    expect(rec.backlog.records).toBe(10);
    expect(rec.waiting).toBe(true);
    rec.persisted(ack(sent[0] as RecorderBatch)); // 4 left: at the low mark
    expect(rec.backlog.records).toBe(4);
    expect(rec.waiting).toBe(false);
  });

  it("keeps waiting while the backlog is between the marks (hysteresis)", () => {
    const { buf, rec, sent } = setup({ ...small, highRecords: 10, lowRecords: 2 });
    for (let t = 1; t <= 5; t++) {
      emit(buf, t, 2);
      rec.collect(t, t * 0.1);
    }
    expect(rec.waiting).toBe(true); // 10 records
    rec.persisted(ack(sent[0] as RecorderBatch)); // 8
    rec.persisted(ack(sent[1] as RecorderBatch)); // 6
    expect(rec.waiting).toBe(true);
    rec.persisted(ack(sent[3] as RecorderBatch)); // 2
    expect(rec.waiting).toBe(false);
  });

  it("counts bytes as well as records: a few large records can put the run to wait", () => {
    const { buf, rec } = setup({ highRecords: 1_000_000, lowRecords: 1000, highBytes: 20_000, lowBytes: 5_000 });
    emit(buf, 1, 3, { text: "y".repeat(8_000) });
    rec.collect(1, 0.1);
    expect(rec.backlog.bytes).toBeGreaterThan(24_000);
    expect(rec.waiting).toBe(true);
  });

  it("counts records handed over before the header as backlog too, and never drops one", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 1000);
    const rec = new RunRecorder({ buffer: buf, profile: RECORDING_PRESETS["default-research"], send: () => {}, flow: small });
    emit(buf, 0, 12);
    rec.collect(0, 0);
    expect(rec.backlog.records).toBe(12);
    expect(rec.waiting).toBe(true);
    expect(buf.all()).toHaveLength(12);
  });

  it("reports how long a wait lasted through the ticks it covered, and a wait that never ends leaves the records intact", () => {
    const { buf, rec, sent } = setup();
    emit(buf, 1, 10);
    rec.collect(1, 0.1);
    expect(rec.waiting).toBe(true);
    emit(buf, 2, 3); // the host would not step, but a degradation record or a command can still be emitted: it is kept and counted
    rec.collect(1, 0.1);
    expect(rec.backlog.records).toBe(13);
    sent.forEach((b) => rec.persisted(ack(b)));
    expect(rec.backlog).toEqual({ records: 0, bytes: 0 });
    expect(rec.waiting).toBe(false);
  });
});
