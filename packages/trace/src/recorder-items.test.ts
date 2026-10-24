import { describe, expect, it } from "vitest";
import { RunRecorder, type PersistedHead, type RecorderBatch, type RecorderItem } from "./recorder.ts";
import { RECORDING_PRESETS } from "./recording-profile.ts";
import { TraceBuffer } from "./trace-buffer.ts";

// F3a M2: what else a recorder hands over besides records: snapshots and belief frames (ADR-0035 addition of 2026-10-17, items 8 and 9). They
// travel in order with the batches (an item goes out before the batch that holds the record that refers to it), wait for the run header
// like everything else, and weigh in the backlog until the persisted head passes them.

type Out = { kind: "batch"; batch: RecorderBatch } | { kind: "item"; item: RecorderItem };

function setup() {
  const buf = new TraceBuffer("run-000001", () => 0, 1000);
  const out: Out[] = [];
  const rec = new RunRecorder({ buffer: buf, profile: RECORDING_PRESETS["default-research"], send: (batch) => out.push({ kind: "batch", batch }), sendItem: (item) => out.push({ kind: "item", item }) });
  return { buf, rec, out };
}
const emit = (buf: TraceBuffer, tick: number, n = 1) => {
  for (let i = 0; i < n; i++) buf.for("world/sim").append({ simTime: tick * 0.1, kind: "event", payload: { op: "x", tick } });
};
const snapshot = (tick: number, bytes = 1000): RecorderItem => ({ type: "snapshot", runId: "run-000001", seq: 0, simTimeS: tick * 0.1, tick, bytes: new Uint8Array(bytes), blobs: [] });
const frames = (n: number, bytes = 500): RecorderItem => ({ type: "frames", runId: "run-000001", frames: Array.from({ length: n }, (_, i) => ({ agentId: "uav-001", seq: i, tick: i, simTime: i * 0.1, kind: "delta" as const, chunks: [i], data: new Uint8Array(bytes) })), blobs: [] });
const ack = (b: RecorderBatch): PersistedHead => ({ runId: b.runId, throughSeq: b.throughSeq, tick: b.tick, simTimeS: b.simTimeS });
const kinds = (out: Out[]) => out.map((o) => (o.kind === "batch" ? "batch" : o.item.type));

describe("RunRecorder: snapshots and frames", () => {
  it("holds them until the run header is stored, then sends them in the order they were given, before the batch", () => {
    const { buf, rec, out } = setup();
    emit(buf, 0, 2);
    rec.enqueue(snapshot(0));
    rec.collect(0, 0);
    rec.enqueue(frames(2));
    expect(out).toEqual([]);
    rec.headerStored();
    expect(kinds(out)).toEqual(["snapshot", "frames", "batch"]);
  });

  it("sends an item before the batch that holds the record referring to it, once the header is stored", () => {
    const { buf, rec, out } = setup();
    rec.headerStored();
    emit(buf, 1, 1); // the record that refers to the snapshot
    rec.enqueue(snapshot(1));
    rec.collect(1, 0.1);
    expect(kinds(out)).toEqual(["snapshot", "batch"]);
    expect((out[1] as { kind: "batch"; batch: RecorderBatch }).batch.records).toHaveLength(1);
  });

  it("sends a batch with no records after an item, so the persisted head can pass it", () => {
    const { rec, out } = setup();
    rec.headerStored();
    rec.enqueue(frames(1));
    rec.collect(3, 0.3);
    expect(kinds(out)).toEqual(["frames", "batch"]);
    const batch = (out[1] as { kind: "batch"; batch: RecorderBatch }).batch;
    expect(batch.records).toEqual([]);
    expect(batch.tick).toBe(3);
  });

  it("counts an item's bytes in the backlog until the persisted head passes the batch that follows it", () => {
    const { buf, rec, out } = setup();
    rec.headerStored();
    emit(buf, 1, 1);
    rec.enqueue(snapshot(1, 40_000));
    rec.collect(1, 0.1);
    expect(rec.backlog.bytes).toBeGreaterThan(40_000);
    const batch = (out.find((o) => o.kind === "batch") as { kind: "batch"; batch: RecorderBatch }).batch;
    rec.persisted(ack(batch));
    expect(rec.backlog).toEqual({ records: 0, bytes: 0 });
  });

  it("counts the bytes of items held for the header as backlog, so a huge start snapshot can put the run to wait", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 1000);
    const rec = new RunRecorder({
      buffer: buf,
      profile: RECORDING_PRESETS["default-research"],
      send: () => {},
      sendItem: () => {},
      flow: { highRecords: 1_000_000, lowRecords: 10, highBytes: 10_000, lowBytes: 1_000 },
    });
    rec.enqueue(snapshot(0, 60_000));
    rec.collect(0, 0);
    expect(rec.backlog.bytes).toBeGreaterThanOrEqual(60_000);
    expect(rec.waiting).toBe(true);
  });

  it("hands metric samples over like any item: held for the header, in order, and weighed in the backlog (ADR-0035 section 4)", () => {
    const { buf, rec, out } = setup();
    const metrics: RecorderItem = { type: "metrics", runId: "run-000001", samples: [{ source: "world/sim", name: "sim.tickMs", tick: 1, simTime: 0.1, value: 1.5 }, { source: "uav-001/body", name: "agent.soc", tick: 1, simTime: 0.1, value: 0.9 }] };
    emit(buf, 1, 1);
    rec.enqueue(metrics);
    rec.collect(1, 0.1);
    expect(out).toEqual([]);
    expect(rec.backlog.bytes).toBeGreaterThanOrEqual(2 * 64);
    rec.headerStored();
    expect(kinds(out)).toEqual(["metrics", "batch"]);
  });

  it("refuses an item when the recorder has no channel for items: nothing is dropped silently", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 1000);
    const rec = new RunRecorder({ buffer: buf, profile: RECORDING_PRESETS["default-research"], send: () => {} });
    rec.headerStored();
    expect(() => rec.enqueue(snapshot(0))).toThrow(/no channel/);
  });
});
