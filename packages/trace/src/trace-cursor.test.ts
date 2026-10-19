import { describe, expect, it } from "vitest";
import { TraceBuffer } from "./trace-buffer.ts";

// F3a M1: a restored run's trace continues the sequence and the time order (ADR-0035 addition of 2026-10-17, item 8).

const rec = (simTime: number) => ({ simTime, kind: "event" as const, agentId: "ugv-001", detail: "full" as const, payload: { op: "x" } });

describe("TraceBuffer cursor", () => {
  it("seeds an empty buffer so the next record continues the sequence and its id", () => {
    const a = new TraceBuffer("run-000007", () => 0);
    const t = a.for("ugv-001/actions");
    for (const s of [0, 0.1, 0.2]) t.append(rec(s));
    const cursor = a.cursor();
    expect(cursor).toEqual({ seq: 3, lastSimTime: 0.2 });
    const b = new TraceBuffer("run-000007", () => 0);
    b.restoreCursor(JSON.parse(JSON.stringify(cursor)));
    const next = b.for("ugv-001/actions").append(rec(0.3));
    expect([next.seq, next.id]).toEqual([3, "run-000007#3"]);
    expect(a.for("ugv-001/actions").append(rec(0.3)).id).toBe(next.id); // what the uninterrupted run writes next
  });

  it("keeps the sim-time order: a record older than the restored time is refused, as in the original run", () => {
    const b = new TraceBuffer("run-000001", () => 0);
    b.restoreCursor({ seq: 10, lastSimTime: 5 });
    expect(() => b.for("ugv-001/actions").append(rec(4.9))).toThrow(/time went backwards/);
    expect(b.for("ugv-001/actions").append(rec(5)).seq).toBe(10);
  });

  it("only restores into an empty buffer, and refuses a cursor that cannot be one", () => {
    const used = new TraceBuffer("run-000001", () => 0);
    used.for("ugv-001/actions").append(rec(0));
    expect(() => used.restoreCursor({ seq: 5, lastSimTime: 1 })).toThrow(/empty buffer/);
    const fresh = new TraceBuffer("run-000001", () => 0);
    expect(() => fresh.restoreCursor({ seq: -1, lastSimTime: 0 })).toThrow(/bad trace cursor/);
    expect(() => fresh.restoreCursor({ seq: 1.5, lastSimTime: 0 })).toThrow(/bad trace cursor/);
    expect(() => fresh.restoreCursor({ seq: 1, lastSimTime: Number.NaN })).toThrow(/bad trace cursor/);
  });
});
