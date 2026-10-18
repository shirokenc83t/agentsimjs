import { describe, expect, it } from "vitest";
import { TraceBuffer } from "./trace-buffer.ts";

// F3a M2: the buffer as the UI cache of a run (ADR-0004 and ADR-0035 additions of 2026-10-17, item 6): in a recorded run it forgets a
// record only once the record is persisted; in an opted-out run it forgets at capacity and counts what it forgot.

const add = (buf: TraceBuffer, n: number, from = 0) => {
  for (let i = 0; i < n; i++) buf.for("world/sim").append({ simTime: from + i, kind: "event", payload: { i: from + i } });
};

describe("TraceBuffer.since", () => {
  it("returns the records from a sequence number on, in order", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 100);
    add(buf, 5);
    expect(buf.since(0).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(buf.since(3).map((r) => r.seq)).toEqual([3, 4]);
    expect(buf.since(5)).toEqual([]);
    expect(buf.since(99)).toEqual([]);
    expect(buf.since(-4).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("starts at the oldest record still held when the cache has forgotten the first ones", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 3);
    add(buf, 6);
    expect(buf.since(0).map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(buf.since(4).map((r) => r.seq)).toEqual([4, 5]);
    expect(buf.nextSeq).toBe(6);
  });
});

describe("a recorded run's cache", () => {
  it("keeps every record that is not persisted, past its capacity", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 3);
    buf.holdUnpersisted();
    add(buf, 10);
    expect(buf.all().map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(buf.dropped).toBe(0);
  });

  it("forgets persisted records beyond its capacity, oldest first, and only those", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 3);
    buf.holdUnpersisted();
    add(buf, 10);
    buf.markPersisted(5); // seq 0..5 are persisted: they go, down to the capacity or to the first one not persisted
    expect(buf.all().map((r) => r.seq)).toEqual([6, 7, 8, 9]);
    add(buf, 1, 10);
    expect(buf.all().map((r) => r.seq)).toEqual([6, 7, 8, 9, 10]); // over capacity: none of them is persisted
    buf.markPersisted(10);
    expect(buf.all().map((r) => r.seq)).toEqual([8, 9, 10]);
    add(buf, 1, 11);
    expect(buf.all().map((r) => r.seq)).toEqual([9, 10, 11]);
    expect(buf.dropped).toBe(0); // nothing was lost: what went is stored
  });

  it("does not move the persisted mark back, and ignores a mark beyond what was written", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 2);
    buf.holdUnpersisted();
    add(buf, 4);
    buf.markPersisted(2);
    expect(buf.all().map((r) => r.seq)).toEqual([2, 3]); // 0..2 persisted: the oldest two go down to the capacity
    buf.markPersisted(0); // back: no effect
    add(buf, 1, 4);
    expect(buf.all().map((r) => r.seq)).toEqual([3, 4]);
    buf.markPersisted(1000); // beyond what was written: counts as what was written
    add(buf, 1, 5);
    expect(buf.all().map((r) => r.seq)).toEqual([4, 5]);
  });
});

describe("an opted-out run's cache", () => {
  it("forgets at capacity and counts what it forgot", () => {
    const buf = new TraceBuffer("run-000001", () => 0, 3);
    add(buf, 8);
    expect(buf.all().map((r) => r.seq)).toEqual([5, 6, 7]);
    expect(buf.dropped).toBe(5);
  });
});
