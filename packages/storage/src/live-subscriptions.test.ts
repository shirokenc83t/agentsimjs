import type { MetricSample, TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { LiveSubscriptions, type LiveBatch } from "./live-subscriptions.ts";

// ADR-0035 section 5: subscriptions evaluate a filter on what the storage worker stored and push the matches batched, at most 10 times a second and at most 2,000 items a
// batch; above the cap the display samples and says so; a closed view leaves nothing behind. A fake clock drives the timers.

class FakeClock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown): void => void this.timers.delete(h as number);
  get pending(): number {
    return this.timers.size;
  }
  /** Moves time forward, firing timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

const rec = (seq: number, over: Partial<TraceRecord> = {}): TraceRecord => ({ id: `run-000001#${seq}`, runId: "run-000001", seq, simTime: seq * 0.1, wallTime: 1, source: "uav-001/body", kind: "event", agentId: "uav-001", payload: { op: "x", seq }, ...over });
const sample = (tick: number, over: Partial<MetricSample> = {}): MetricSample => ({ source: "uav-001/body", name: "agent.soc", tick, simTime: tick * 0.1, value: 1 - tick / 1000, ...over });

function setup(opts: { maxPerBatch?: number; maxSubscriptions?: number } = {}) {
  const clock = new FakeClock();
  const out: LiveBatch[] = [];
  const live = new LiveSubscriptions({ emit: (b) => out.push(b), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...opts });
  return { clock, out, live };
}

describe("LiveSubscriptions", () => {
  it("delivers the records that match, and only the ones of its run, after the first interval has gone", () => {
    const { live, out, clock } = setup();
    expect(live.subscribe("v1", "run-000001", "kind:event agent:uav-001").ok).toBe(true);
    live.offerRecords([rec(1), rec(2, { kind: "action" }), rec(3, { runId: "run-000002", id: "run-000002#3" }), rec(4, { agentId: "ugv-001" }), rec(5)]);
    clock.advance(0); // the first batch of a view goes out at once (nothing was emitted before)
    clock.advance(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.records.map((r) => r.seq)).toEqual([1, 5]);
    expect(out[0]).toMatchObject({ viewId: "v1", runId: "run-000001", matched: 2, shown: 2, totalMatched: 2, totalShown: 2, sampled: false, samples: [] });
  });

  it("pushes at most 10 times a second per view, however many batches arrive", () => {
    const { live, out, clock } = setup();
    live.subscribe("v1", "run-000001", "kind:event");
    let seq = 0;
    for (let ms = 0; ms < 1000; ms += 5) {
      live.offerRecords([rec(seq++)]);
      clock.advance(5);
    }
    clock.advance(200);
    expect(out.length).toBeGreaterThanOrEqual(9);
    expect(out.length).toBeLessThanOrEqual(11);
    // Nothing is lost between pushes: what matched is what was shown, in order.
    expect(out.reduce((n, b) => n + b.shown, 0)).toBe(seq);
    expect(out.flatMap((b) => b.records.map((r) => r.seq))).toEqual(Array.from({ length: seq }, (_, i) => i));
  });

  it("above the cap of a batch the display samples evenly and says how many matched against how many it shows; the next batch starts again", () => {
    const { live, out, clock } = setup({ maxPerBatch: 100 });
    live.subscribe("v1", "run-000001", "kind:event");
    live.offerRecords(Array.from({ length: 1000 }, (_, i) => rec(i)));
    clock.advance(1);
    expect(out).toHaveLength(1);
    const b = out[0] as LiveBatch;
    expect(b).toMatchObject({ matched: 1000, shown: 100, totalMatched: 1000, totalShown: 100, sampled: true });
    expect(b.records).toHaveLength(100);
    // An even spread over the whole interval: first and one near the end, ascending, no repeats.
    expect(b.records[0]?.seq).toBe(0);
    expect((b.records.at(-1)?.seq ?? 0) > 900).toBe(true);
    expect(b.records.map((r) => r.seq)).toEqual([...b.records.map((r) => r.seq)].sort((x, y) => x - y));
    clock.advance(100);
    live.offerRecords([rec(2000), rec(2001)]);
    clock.advance(100);
    expect(out[1]).toMatchObject({ matched: 2, shown: 2, totalMatched: 1002, totalShown: 102, sampled: false });
  });

  it("the default cap is 2,000 a batch", () => {
    const { live, out, clock } = setup();
    live.subscribe("v1", "run-000001", "kind:event");
    live.offerRecords(Array.from({ length: 5000 }, (_, i) => rec(i)));
    clock.advance(1);
    expect(out[0]).toMatchObject({ matched: 5000, shown: 2000, sampled: true });
  });

  it("metric subscriptions take samples, by name and source, and records never reach them", () => {
    const { live, out, clock } = setup();
    live.subscribe("m1", "run-000001", "metric:agent.soc source:uav-001/body");
    live.offerSamples("run-000001", [sample(1), sample(2, { name: "agent.speedMps" }), sample(3, { source: "uav-002/body" }), sample(4)]);
    live.offerSamples("run-000002", [sample(9)]);
    live.offerRecords([rec(1)]);
    clock.advance(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.samples.map((s) => s.tick)).toEqual([1, 4]);
    expect(out[0]?.records).toEqual([]);
  });

  it("changing the filter drops what waited under the old one and counts again; an invalid one leaves the old one in place", () => {
    const { live, out, clock } = setup();
    live.subscribe("v1", "run-000001", "kind:action");
    live.offerRecords([rec(1, { kind: "action" })]);
    expect(live.change("v1", "kind:event ((").ok).toBe(false);
    expect(live.change("v1", "kind:event").ok).toBe(true);
    clock.advance(500);
    expect(out).toEqual([]);
    live.offerRecords([rec(2, { kind: "action" }), rec(3)]);
    clock.advance(1);
    expect(out[0]?.records.map((r) => r.seq)).toEqual([3]);
    expect(out[0]?.totalMatched).toBe(1);
    expect(live.change("nobody", "kind:event")).toMatchObject({ ok: false, error: { code: "unknown_view" } });
  });

  it("a closed view leaves no subscription and no timer behind, and nothing is delivered to it afterwards", () => {
    const { live, out, clock } = setup();
    live.subscribe("v1", "run-000001", "kind:event");
    live.subscribe("v2", "run-000001", "kind:event");
    live.offerRecords([rec(1)]);
    expect(clock.pending).toBe(2);
    expect(live.unsubscribe("v1")).toBe(true);
    expect(live.size).toBe(1);
    expect(clock.pending).toBe(1);
    expect(live.unsubscribe("v1")).toBe(false);
    live.unsubscribe("v2");
    expect(live.size).toBe(0);
    expect(clock.pending).toBe(0);
    live.offerRecords([rec(2)]);
    clock.advance(1000);
    expect(out).toEqual([]);
    // Disposing the lot (the worker closing) also leaves nothing.
    live.subscribe("v3", "run-000001", "kind:event");
    live.offerRecords([rec(3)]);
    live.dispose();
    expect(live.size).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("refuses a bad filter, a second subscription for a view, a bad id and too many views, and opens nothing", () => {
    const { live } = setup({ maxSubscriptions: 2 });
    expect(live.subscribe("v1", "run-000001", "kind:nonsense")).toMatchObject({ ok: false, error: { code: "invalid_filter" } });
    expect(live.size).toBe(0);
    expect(live.subscribe("v1", "run-000001", "kind:event").ok).toBe(true);
    expect(live.subscribe("v1", "run-000001", "kind:event")).toMatchObject({ ok: false, error: { code: "duplicate_view" } });
    expect(live.subscribe("bad id!", "run-000001", "")).toMatchObject({ ok: false, error: { code: "invalid_view" } });
    expect(live.subscribe("v2", "not-a-run", "")).toMatchObject({ ok: false, error: { code: "invalid_view" } });
    expect(live.subscribe("v2", "run-000001", "").ok).toBe(true);
    expect(live.subscribe("v3", "run-000001", "")).toMatchObject({ ok: false, error: { code: "too_many_subscriptions" } });
    expect(live.size).toBe(2);
  });

  it("flushNow pushes what waits at once, whatever the interval", () => {
    const { live, out } = setup();
    live.subscribe("v1", "run-000001", "kind:event");
    live.offerRecords([rec(1)]);
    live.flushNow();
    expect(out).toHaveLength(1);
  });
});
