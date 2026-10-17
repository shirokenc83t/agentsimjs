import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { runReference } from "../testing/reference-run.ts";

/*
 * ADR-0037 at run level (long runs: `pnpm test:determinism`): a strategy is a planner configuration, so the run is still
 * a pure function of (scenario, seed, configuration), and a one-node strategy is the plain algorithm: the same world
 * state at every checkpoint.
 */

const TICKS = 1500;
const ALGORITHMS = [
  ["astar", "astar", { kind: "algorithm", algorithm: "astar" }],
  ["dijkstra", "dijkstra", { kind: "algorithm", algorithm: "dijkstra" }],
  ["hpa", "hpa", { kind: "algorithm", algorithm: "hpa" }],
  ["weighted-astar", { "weighted-astar": { weight: 2 } }, { kind: "algorithm", algorithm: "weighted-astar", weight: 2 }],
] as const;

const doc = (root: unknown, id = "run-test") => ({ schemaVersion: 0 as const, id, version: 1, root });
const plain = (algorithm: unknown) => ({ planning: { default: { algorithm } } }) as never;
const withStrategy = (strategy: unknown) => ({ planning: { default: { strategy } } }) as never;

const plans = (recs: readonly TraceRecord[]) => recs.filter((r) => r.kind === "compute" && (r.payload as { op?: string }).op === "plan");
/** A plan record as the simulation sees it: without the strategy-only fields and the algorithm label. */
const core = (r: TraceRecord) => {
  const { algorithm: _a, strategy: _s, ...rest } = r.payload as Record<string, unknown>;
  return { source: r.source, simTime: r.simTime, ...rest };
};

describe("a one-node strategy is the plain algorithm, in a whole run", () => {
  for (const [name, spec, root] of ALGORITHMS) {
    it(`${name}: the same world state at every checkpoint, and the same planning records but for the strategy fields`, async () => {
      const a = await runReference({ runConfig: plain(spec) }, TICKS);
      const b = await runReference({ runConfig: withStrategy(doc(root)) }, TICKS);
      expect(b.checkpoints).toEqual(a.checkpoints);
      const pa = plans(a.run.trace.all());
      const pb = plans(b.run.trace.all());
      expect(pa.length).toBeGreaterThan(0);
      expect(pb.map(core)).toEqual(pa.map(core));
      for (const r of pa) expect((r.payload as { strategy?: unknown }).strategy).toBeUndefined(); // a plain record is untouched
      for (const r of pb) expect((r.payload as { strategy?: { searches: unknown[] } }).strategy?.searches).toHaveLength(1);
    }, 120_000);
  }
});

describe("strategies with several stages", () => {
  const presets = [
    { ref: "astar-then-hpa", version: 1 },
    { ref: "short-astar-long-hpa", version: 1 },
    { ref: "anytime-weighted", version: 1 },
  ];
  const refine = doc({ kind: "refine", mode: "eager", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } }, "refine-run");

  for (const strategy of [...presets, refine]) {
    const name = "ref" in strategy ? strategy.ref : strategy.id;
    it(`${name}: same seed, same states and the same trace; caches and preparing planning at load change nothing`, async () => {
      const cfg = { runConfig: withStrategy(strategy) };
      const first = await runReference(cfg, TICKS);
      const again = await runReference(cfg, TICKS);
      expect(again.checkpoints).toEqual(first.checkpoints);
      expect(JSON.stringify(plans(again.run.trace.all()).map(core))).toBe(JSON.stringify(plans(first.run.trace.all()).map(core)));
      const uncached = await runReference({ ...cfg, planningCachesEnabled: false }, TICKS);
      expect(uncached.checkpoints).toEqual(first.checkpoints);
      const prepared = await runReference({ ...cfg, preparePlanning: true }, TICKS);
      expect(prepared.checkpoints).toEqual(first.checkpoints);
      // The records carry the strategy: its id, the conditions evaluated and every search.
      const recs = plans(first.run.trace.all());
      expect(recs.length).toBeGreaterThan(0);
      for (const r of recs) {
        const p = r.payload as { algorithm: string; strategy?: { id: string; version: number; hash: string; searches: { expansions: number }[] } };
        expect(p.algorithm).toBe(`strategy:${name}@1`);
        expect(p.strategy?.version).toBe(1);
        expect(p.strategy?.hash).toMatch(/^[0-9a-f]{8}$/);
        expect(p.strategy?.searches.length).toBeGreaterThan(0);
        const charged = (r.payload as { expansionsCharged: number }).expansionsCharged;
        expect(charged).toBeGreaterThanOrEqual(p.strategy?.searches.reduce((a, s) => a + s.expansions, 0) ?? 0); // restarts add to it
      }
    }, 240_000);
  }

  it("a different strategy plans differently: the run changes with the planner (it is an experimental factor)", async () => {
    const a = await runReference({ runConfig: withStrategy({ ref: "anytime-weighted", version: 1 }) }, TICKS);
    const b = await runReference({ runConfig: withStrategy({ ref: "astar-only", version: 1 }) }, TICKS);
    const charged = (r: Awaited<ReturnType<typeof runReference>>) => plans(r.run.trace.all()).map((p) => (p.payload as { expansionsCharged: number }).expansionsCharged);
    expect(charged(a)).not.toEqual(charged(b));
  }, 120_000);
});

describe("lazy refine in a whole run (F2b M3)", () => {
  // A small per-tick planning budget, so planning really overlaps with moving and holding (at the default one a query ends in a tick or two).
  const slow = (strategy: unknown) => ({ planning: { default: { strategy, onboardComputeExpansionsPerTick: 100 } } }) as never;
  const refineOf = (mode: "lazy" | "eager") => doc({ kind: "refine", mode, coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } }, `refine-${mode}-run`);
  const legNotes = (recs: readonly TraceRecord[]) => recs.filter((r) => r.kind === "action" && (r.payload as { op?: string }).op === "leg");
  const ends = (recs: readonly TraceRecord[]) =>
    recs
      .filter((r) => r.kind === "action" && (r.payload as { op?: string }).op === "end")
      .map((r) => [r.agentId, (r.payload as { name?: string }).name, (r.payload as { status?: string }).status, ((r.payload as { failure?: { code?: string } }).failure ?? {}).code]);

  it("is repeatable: the same states and trace twice, with caches off, and with planning prepared at load", async () => {
    const cfg = { runConfig: slow(refineOf("lazy")) };
    const first = await runReference(cfg, TICKS);
    const again = await runReference(cfg, TICKS);
    expect(again.checkpoints).toEqual(first.checkpoints);
    expect(JSON.stringify(again.run.trace.all().map(({ wallTime: _w, ...r }) => r))).toBe(JSON.stringify(first.run.trace.all().map(({ wallTime: _w, ...r }) => r)));
    expect((await runReference({ ...cfg, planningCachesEnabled: false }, TICKS)).checkpoints).toEqual(first.checkpoints);
    expect((await runReference({ ...cfg, preparePlanning: true }, TICKS)).checkpoints).toEqual(first.checkpoints);
    expect(legNotes(first.run.trace.all()).length).toBeGreaterThan(0); // the run really used legs
  }, 240_000);

  it("is the eager plan started earlier: the same first plans, the first leg before the eager path is ready, the same action outcomes, no collision", async () => {
    const lazy = await runReference({ runConfig: slow(refineOf("lazy")) }, TICKS);
    const eager = await runReference({ runConfig: slow(refineOf("eager")) }, TICKS);
    const lr = lazy.run.trace.all();
    const er = eager.run.trace.all();
    const firstPlans = (recs: readonly TraceRecord[]) => {
      const seen = new Map<string, ReturnType<typeof core>>();
      for (const r of plans(recs)) if (r.agentId !== undefined && !seen.has(r.agentId)) seen.set(r.agentId, { ...core(r), source: r.source, simTime: r.simTime });
      return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    };
    // The first plan of each agent is the same query on the same map: the same path, charge and completion tick.
    const lp = firstPlans(lr);
    expect(lp.length).toBeGreaterThan(0);
    expect(lp).toEqual(firstPlans(er));
    // Each agent's first leg is ready before the eager plan would be (its completion tick).
    const eagerReady = new Map<string, number>();
    for (const r of plans(er)) if (r.agentId !== undefined && !eagerReady.has(r.agentId)) eagerReady.set(r.agentId, (r.payload as { completedTick: number }).completedTick);
    const firstLeg = new Map<string, number>();
    for (const r of legNotes(lr)) if (r.agentId !== undefined && !firstLeg.has(r.agentId)) firstLeg.set(r.agentId, (r.payload as { tick: number }).tick);
    for (const [agent, ready] of eagerReady) {
      const t = firstLeg.get(agent);
      if (t === undefined) continue; // an agent whose first plan found no path has no legs
      expect(t, agent).toBeLessThan(ready);
    }
    expect([...firstLeg.values()].length).toBeGreaterThan(0);
    // Planning concurrently must not turn a goTo that succeeds into a failure, nor cause a collision.
    expect(ends(lr)).toEqual(ends(er));
    expect(ends(lr).some((e) => e[3] === "collision")).toBe(false);
  }, 240_000);
});
