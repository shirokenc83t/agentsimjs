import { TRAIL_MAX_POINTS, TRAIL_STRIDE } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { TRAIL_STEP_M, TrailRecorder } from "./trail-recorder.ts";
import { TrailStore } from "./trail-store.ts";

/** What the main thread ends up with, per agent, after applying every drained message. */
function snapshotOf(store: TrailStore, agents: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < agents; i++) out.push(Array.from(store.path(i).points));
  return out;
}

function drainInto(rec: TrailRecorder, store: TrailStore): void {
  const d = rec.drain();
  if (d) store.apply(d);
}

/**
 * Synthetic agents moving 0.2 m per tick (2 m/s at 0.1 s) along different deterministic curves, fed to the
 * recorder for `ticks` ticks; the client store drains every `drainEvery` ticks (0: only at the end).
 */
function syntheticRun(agents: number, ticks: number, drainEvery: number): { rec: TrailRecorder; store: TrailStore; maxCount: number } {
  const rec = new TrailRecorder(agents);
  const store = new TrailStore(agents);
  let maxCount = 0;
  for (let t = 0; t <= ticks; t++) {
    for (let i = 0; i < agents; i++) {
      const r = 20 + 3 * i;
      const a = (0.2 * t) / r; // arc length 0.2 m per tick
      rec.observe(i, 500 + r * Math.cos(a + i) + 0.001 * t, 500 + r * Math.sin(a + i), i % 3 === 0 ? 20 : 0);
      maxCount = Math.max(maxCount, rec.count(i));
    }
    if (drainEvery > 0 && t % drainEvery === 0) drainInto(rec, store);
  }
  drainInto(rec, store);
  return { rec, store, maxCount };
}

describe("executed paths from simulation state (bounded, F2 M1b)", () => {
  it("keeps the start and then a point each time the agent moved TRAIL_STEP_M from the last kept one", () => {
    const r = new TrailRecorder(1);
    r.observe(0, 0, 0, 0);
    r.observe(0, 0.1, 0, 0); // < step: dropped
    r.observe(0, 0.3, 0, 0);
    r.observe(0, 0.4, 0, 0); // 0.1 from the last kept: dropped
    const d = r.drain();
    expect(Array.from(d?.points ?? [])).toEqual([0, 0, 0, 0.30000001192092896, 0, 0]);
    expect(d?.replace).toBeUndefined();
    expect(TRAIL_STEP_M).toBe(0.25);
    expect(r.drain()).toBeUndefined();
  });

  it("on reaching the cap: doubles the step, thins deterministically (first and last kept) and sends a replace", () => {
    const r = new TrailRecorder(1);
    for (let k = 0; k < TRAIL_MAX_POINTS - 1; k++) r.observe(0, k * 0.25, 0, 0);
    expect(r.count(0)).toBe(TRAIL_MAX_POINTS - 1);
    expect(r.drain()?.replace).toBeUndefined();
    r.observe(0, (TRAIL_MAX_POINTS - 1) * 0.25, 0, 0); // the 2048th point
    expect(r.step(0)).toBe(0.5);
    expect(r.count(0)).toBe(TRAIL_MAX_POINTS / 2 + 1); // every other point, plus the last one
    const d = r.drain();
    expect(d?.agents.length).toBe(0); // no appends: the replace carries everything
    expect(Array.from(d?.replace?.agents ?? [])).toEqual([0]);
    expect(Array.from(d?.replace?.offsets ?? [])).toEqual([0, TRAIL_MAX_POINTS / 2 + 1]);
    const xs = Array.from(d?.replace?.points ?? []).filter((_, k) => k % TRAIL_STRIDE === 0);
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBe(0.5);
    expect(xs.at(-1)).toBe((TRAIL_MAX_POINTS - 1) * 0.25);
    // Afterwards, points are kept at the doubled step from the last kept one.
    r.observe(0, (TRAIL_MAX_POINTS - 1) * 0.25 + 0.3, 0, 0);
    expect(r.drain()).toBeUndefined();
    r.observe(0, (TRAIL_MAX_POINTS - 1) * 0.25 + 0.5, 0, 0);
    expect(r.drain()?.agents.length).toBe(1);
  });

  it("the client's trails are identical whatever the drain cadence (1, 7, 37 ticks, or once at the end)", () => {
    const ref = syntheticRun(4, 6000, 1);
    expect(ref.rec.step(0)).toBeGreaterThan(TRAIL_STEP_M); // thinning happened
    const expected = snapshotOf(ref.store, 4);
    for (const every of [7, 37, 0]) expect(snapshotOf(syntheticRun(4, 6000, every).store, 4), `every ${every}`).toEqual(expected);
    for (let i = 0; i < 4; i++) expect(Array.from(ref.store.path(i).points)).toEqual(Array.from(ref.rec.points(i)));
  });

  it("a 50-agent, 30,000-tick run stays within TRAIL_MAX_POINTS per agent, on both sides", () => {
    const { rec, store, maxCount } = syntheticRun(50, 30_000, 10);
    expect(maxCount).toBeLessThan(TRAIL_MAX_POINTS);
    for (let i = 0; i < 50; i++) {
      expect(store.path(i).count).toBeLessThan(TRAIL_MAX_POINTS);
      expect(store.path(i).count).toBe(rec.count(i));
      expect(store.path(i).version).toBeGreaterThan(0); // each agent was thinned at least once
    }
  });

  // The same property on a real reference run is in trail-recorder.determinism.test.ts (the `determinism` project).
});
