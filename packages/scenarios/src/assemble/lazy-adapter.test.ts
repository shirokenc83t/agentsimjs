import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { f2DiscoveryScenario, F2_DISCOVERY_ID } from "../presets/f2-presets.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { assembleRun } from "./assemble.ts";

// F2b M3: the adapter hands the legs of a lazy plan to the action runtime, cleans up, and traces an interruption.

const lazy = { schemaVersion: 0 as const, id: "lazy-adapter", version: 1, root: { kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } };
const eager = { ...lazy, id: "eager-adapter", root: { ...lazy.root, mode: "eager" } };

function assemble(strategy: unknown) {
  const loaded = loadScenario(f2DiscoveryScenario());
  if (!loaded.ok) throw new Error(loaded.error.message);
  // Ideal agents plan on the ground truth, which the test can edit.
  const rc = { schemaVersion: 0, scenario: { id: F2_DISCOVERY_ID, version: 1 }, beliefs: { default: { init: "ideal" } }, planning: { default: { strategy, onboardComputeExpansionsPerTick: 100 } } } as unknown as RunConfigDocument;
  const resolved = resolveRunConfig(rc, { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, 1_000_000);
  const run = assembleRun(loaded.value, resolved.value, trace, { dtS: 0.1 });
  const agent = loaded.value.agents.find((a) => a.kind === "ugv");
  if (!agent) throw new Error("no ground vehicle");
  return { run, trace, grid: loaded.value.grid, agentId: agent.id, from: { x: agent.start.xM, y: agent.start.yM } };
}

/** A free point well away from `from`, found on the grid itself. */
function farFree(grid: ReturnType<typeof assemble>["grid"], from: { x: number; y: number }): { x: number; y: number } {
  for (let r = 40; r >= 10; r -= 2) {
    for (let k = 0; k < 16; k++) {
      const ang = (k * Math.PI) / 8;
      const x = from.x + r * Math.cos(ang);
      const y = from.y + r * Math.sin(ang);
      const i = grid.cellI(x);
      const j = grid.cellJ(y);
      if (grid.inBounds(i, j) && !grid.isBlocked(i, j)) return { x, y };
    }
  }
  throw new Error("no free target");
}

describe("PlanningServiceAdapter and lazy plans", () => {
  it("hands out the legs of a lazy plan, the first before an eager plan of the same strategy is done, and forgets the outcome", () => {
    const l = assemble(lazy);
    const e = assemble(eager);
    const to = farFree(l.grid, l.from);
    const q = { from: l.from, to };
    const lq = l.run.planner.submit(l.agentId, q, 0);
    const eq = e.run.planner.submit(e.agentId, q, 0);
    if (!lq.ok || !eq.ok) throw new Error("submit failed");
    let firstLeg = -1;
    let eagerDone = -1;
    const legs: { index: number; count: number; last: boolean; points: number }[] = [];
    let end: { done: boolean; status?: string } | undefined;
    for (let t = 0; t < 3000 && (!end || eagerDone < 0); t++) {
      l.run.planner.advance(t);
      e.run.planner.advance(t);
      const p = end ? undefined : l.run.planner.takeLegs?.(l.agentId, lq.value);
      if (p) {
        if (p.legs.length > 0 && firstLeg < 0) firstLeg = t;
        for (const leg of p.legs) legs.push({ index: leg.index, count: leg.count, last: leg.last, points: leg.waypoints.length });
        expect(typeof p.map.version).toBe("number");
        if (p.done) end = { done: true, ...(p.status ? { status: p.status } : {}) };
      }
      if (eagerDone < 0 && e.run.planner.take(e.agentId, eq.value)) eagerDone = t;
    }
    expect(end).toEqual({ done: true, status: "found" });
    expect(legs.length).toBeGreaterThan(1);
    expect(legs.map((x) => x.index)).toEqual(legs.map((_, k) => k));
    expect(legs.at(-1)?.last).toBe(true);
    expect(legs.every((x) => x.points >= 1)).toBe(true);
    expect(firstLeg).toBeGreaterThanOrEqual(0);
    expect(firstLeg).toBeLessThan(eagerDone);
    // The finished outcome of a lazy plan is not kept for a `take` that will never come (the legs carried it).
    expect(l.run.planner.take(l.agentId, lq.value)).toBeUndefined();
    // A query that is not lazy has no legs.
    const second = e.run.planner.submit(e.agentId, q, 5000);
    if (!second.ok) throw new Error("submit failed");
    e.run.planner.advance(5001);
    expect(e.run.planner.takeLegs?.(e.agentId, second.value)).toBeUndefined();
  });

  it("an interruption by a map change is traced as a restart marked interrupted, and ends the legs with no outcome", () => {
    const l = assemble(lazy);
    const to = farFree(l.grid, l.from);
    const sub = l.run.planner.submit(l.agentId, { from: l.from, to }, 0);
    if (!sub.ok) throw new Error("submit failed");
    let got = false;
    let t = 0;
    for (; t < 3000 && !got; t++) {
      l.run.planner.advance(t);
      got = (l.run.planner.takeLegs?.(l.agentId, sub.value)?.legs.length ?? 0) > 0;
    }
    expect(got).toBe(true);
    // A change next to the start, in a chunk the first leg's search read.
    const si = l.grid.cellI(l.from.x);
    const sj = l.grid.cellJ(l.from.y);
    l.grid.setCell("occupancy", si + 2, sj + 2, l.grid.isBlocked(si + 2, sj + 2) ? 0 : 1);
    l.run.planner.advance(t);
    const p = l.run.planner.takeLegs?.(l.agentId, sub.value);
    expect(p).toMatchObject({ done: true, interrupted: "map_changed", legs: [] });
    const restarts = l.trace.all().filter((r) => r.kind === "compute" && (r.payload as { op?: string }).op === "restart");
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.payload).toMatchObject({ queryId: sub.value, interrupted: true });
    expect(l.trace.all().filter((r) => r.kind === "compute" && (r.payload as { op?: string }).op === "plan")).toEqual([]); // no outcome
  });
});
