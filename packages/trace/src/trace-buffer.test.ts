import { RealtimeDriver, Scheduler, validate } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { TraceBuffer } from "./trace-buffer.ts";
import { TraceRecord } from "./trace-record.ts";

describe("TraceBuffer", () => {
  it("records realtime tick skips as valid degradation trace records (ADR-0013)", () => {
    const buf = new TraceBuffer("run-000001", () => 1_700_000_000_000);
    let ticks = 0;
    const s = new Scheduler({ step: () => void ticks++ }, 0.1);
    const d = new RealtimeDriver(s, 10, (e) => buf.degradation(e), 4);
    d.start(0);
    d.advance(100);
    d.advance(2000); // 19 due -> 4 run, 15 skipped
    const deg = buf.ofKind("degradation");
    expect(deg).toHaveLength(1);
    expect(deg[0]).toMatchObject({ id: "run-000001#0", seq: 0, kind: "degradation", simTime: 0.5, payload: { reason: "tick-overrun", skippedTicks: 15 } });
    expect(validate(TraceRecord, deg[0]).ok).toBe(true);
    expect(ticks).toBe(5);
  });

  it("assigns increasing sequence numbers and bounds memory", () => {
    const buf = new TraceBuffer("run-000002", () => 0, 3);
    for (let i = 0; i < 5; i++) buf.for("world/sim").append({ simTime: i, kind: "event", payload: { i } });
    expect(buf.all().map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(buf.dropped).toBe(2);
  });

  it("records the wait for the writer as a valid storage_backpressure degradation (ADR-0013 addition of 2026-10-17)", () => {
    const buf = new TraceBuffer("run-000003", () => 1_700_000_000_000);
    const r = buf.storageBackpressure({ tick: 120, simTimeS: 12, backlogRecords: 50_021, backlogBytes: 9_000_000, waitMs: 840 });
    expect(r).toMatchObject({ kind: "degradation", source: "world/sim", detail: "full", simTime: 12, payload: { reason: "storage_backpressure", tick: 120, backlogRecords: 50_021, backlogBytes: 9_000_000, waitMs: 840 } });
    expect(validate(TraceRecord, r).ok).toBe(true);
  });
});
