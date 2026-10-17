import { BeliefGrid, BeliefMap, GridSpace, missionOf } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { isValidPath, randomGrid, referenceCost, UGV } from "../testing/fixtures.ts";
import { PlanningService, type PlanOutcome, type PlanningConfig, type PlanRequest } from "./planning-service.ts";
import type { StrategyNode } from "./strategy/schema.ts";
import type { StrategyPlan } from "./strategy/runner.ts";

// ADR-0037 (accepted 2026-10-13) and its additions: the planner executes strategies as sequences of ordinary searches under
// ADR-0024's charging rules. These are the ROADMAP F2b criteria at the service level.

const algo = (algorithm: string, extra: Record<string, unknown> = {}) => ({ kind: "algorithm", algorithm, ...extra }) as unknown as StrategyNode;
const node = (n: unknown) => n as StrategyNode;
const plan = (root: StrategyNode, id = "test"): StrategyPlan => ({ id, version: 1, hash: "0000abcd", root });

const cfg = (over: Partial<PlanningConfig> = {}): PlanningConfig => ({ algorithm: { kind: "astar" }, onboardComputeExpansionsPerTick: 300, totalBudget: 1_000_000, ...over });
const withStrategy = (root: StrategyNode, over: Partial<PlanningConfig> = {}): PlanningConfig => cfg({ strategy: plan(root), ...over });

const req = (agentId: string, from: [number, number], to: [number, number], config = cfg()): PlanRequest => ({
  agentId,
  traversal: UGV,
  config,
  from: { x: from[0] + 0.5, y: from[1] + 0.5 },
  to: { x: to[0] + 0.5, y: to[1] + 0.5 },
});

function workloadGrid(): GridSpace {
  const g = randomGrid(8, 64, 0.18, 16);
  for (const [i, j] of [[1, 1], [60, 60], [2, 60], [60, 2], [5, 5], [6, 50], [30, 30], [1, 62], [3, 3], [9, 9], [62, 62], [12, 12], [20, 8]] as [number, number][]) {
    g.setCell("occupancy", i, j, 0);
    g.setCell("terrainCost", i, j, 10);
  }
  return g;
}

/** Submits at `tick`, ticks until it completes (or `maxTicks`), returns the outcome. */
function solve(service: PlanningService, r: PlanRequest, tick = 1, maxTicks = 5000): PlanOutcome {
  expect(service.submit(r, tick).ok).toBe(true);
  for (let t = tick; t < tick + maxTicks; t++) {
    service.tick(t);
    const done = service.takeCompleted().find((o) => o.agentId === r.agentId);
    if (done) return done;
  }
  throw new Error("query did not complete");
}
/** Everything about an outcome that the simulation can see (cache hits and the strategy trace excluded). */
const semantic = (o: PlanOutcome) => ({ ...o, cacheHit: undefined, strategy: undefined, space: undefined });

describe("a one-node strategy is the plain algorithm", () => {
  const cases: [string, PlanningConfig["algorithm"], StrategyNode][] = [
    ["astar", { kind: "astar" }, algo("astar")],
    ["dijkstra", { kind: "dijkstra" }, algo("dijkstra")],
    ["weighted-astar", { kind: "weighted-astar", weight: 2 }, algo("weighted-astar", { weight: 2 })],
    ["hpa", { kind: "hpa" }, algo("hpa")],
  ];
  for (const [name, algorithm, root] of cases) {
    it(`${name}: same path, cost, charge, completion tick and counters, caches on and off, cold and warm`, () => {
      const grid = workloadGrid();
      for (const cachesEnabled of [true, false]) {
        const a = new PlanningService(grid, { cachesEnabled });
        const b = new PlanningService(grid, { cachesEnabled });
        for (let k = 0; k < 3; k++) {
          // the third round repeats the first query: warm caches on
          const [from, to] = [[[1, 1], [60, 60]], [[2, 60], [60, 2]], [[1, 1], [60, 60]]][k] as [[number, number], [number, number]];
          const plain = solve(a, req("ugv-001", from, to, cfg({ algorithm })), 1 + 100 * k);
          const strat = solve(b, req("ugv-001", from, to, withStrategy(root)), 1 + 100 * k);
          expect(semantic(strat), `${name} round ${k} caches ${cachesEnabled}`).toEqual(semantic(plain));
          expect(strat.strategy?.searches).toHaveLength(1);
          expect(plain.strategy).toBeUndefined(); // a plain query has no strategy trace
        }
      }
    });
  }
});

describe("select", () => {
  const root = node({ kind: "select", branches: [{ when: "dist.m <= 20", then: algo("astar") }], else: algo("hpa") });
  it("takes A* for a short trip and HPA* for a long one, and the trace shows the branch and the value", () => {
    const service = new PlanningService(workloadGrid());
    const short = solve(service, req("ugv-001", [1, 1], [12, 12], withStrategy(root)));
    expect(short.strategy?.selects).toEqual([{ path: "/root", branch: 0, values: { "dist.m": Math.sqrt(11 * 11 + 11 * 11) } }]);
    expect(short.strategy?.searches.map((s) => s.algorithm)).toEqual(["astar"]);
    const long = solve(service, req("ugv-002", [1, 1], [60, 60], withStrategy(root)), 1);
    expect(long.strategy?.selects[0]).toMatchObject({ path: "/root", branch: "else" });
    expect(long.strategy?.selects[0]?.values["dist.m"]).toBeCloseTo(Math.sqrt(59 * 59 * 2), 9);
    expect(long.strategy?.searches.map((s) => s.algorithm)).toEqual(["hpa"]);
  });

  it("evaluates vehicle, altitude, budget and the profile features from the planner's inputs", () => {
    const checks: [string, boolean][] = [
      ['vehicle == "ugv"', true],
      ["vehicle == \"uav\"", false],
      ["altitude == 0", true],
      ["budget.total == 777777", true],
      ["profile.distance and not profile.time", true],
      ["profile.terrain", false],
      ["replan.count == 0", true],
    ];
    for (const [when, expected] of checks) {
      const service = new PlanningService(workloadGrid());
      const o = solve(service, req("ugv-001", [1, 1], [12, 12], withStrategy(node({ kind: "select", branches: [{ when, then: algo("dijkstra") }], else: algo("astar") }), { totalBudget: 777_777 })));
      expect(o.strategy?.searches[0]?.algorithm, when).toBe(expected ? "dijkstra" : "astar");
    }
  });

  it("known.frac is measured on the agent's own belief map: an agent that has seen nothing gets 0, ideal ground truth 1", () => {
    const world = new GridSpace({ sizeX: 40, sizeY: 40, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 60 } });
    const belief = new BeliefMap(world.sizeX, world.sizeY, world.chunkSize);
    const grid = new BeliefGrid(missionOf(world), belief);
    const service = new PlanningService(world, { mapFor: (k) => (k === "scout" ? grid : undefined) });
    const root = node({ kind: "select", branches: [{ when: "known.frac >= 0.5", then: algo("astar") }], else: algo("dijkstra") });
    const scout = solve(service, { ...req("scout", [2, 2], [30, 30], withStrategy(root)), mapKey: "scout" });
    expect(scout.strategy?.selects[0]).toMatchObject({ branch: "else", values: { "known.frac": 0 } });
    const ideal = solve(service, req("ugv-009", [2, 2], [30, 30], withStrategy(root)));
    expect(ideal.strategy?.selects[0]).toMatchObject({ branch: 0, values: { "known.frac": 1 } });
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) belief.observeFree(i, j, 20);
    const learned = solve(service, { ...req("scout", [2, 2], [30, 30], withStrategy(root)), mapKey: "scout" }, 50);
    expect(learned.strategy?.selects[0]).toMatchObject({ branch: 0, values: { "known.frac": 1 } });
  });
});

describe("fallback and the charge across stages", () => {
  const root = node({ kind: "fallback", stages: [algo("astar", { stageBudget: 100 }), algo("hpa")] });
  const run = (service: PlanningService, tick = 1, perTick = 300) => solve(service, req("ugv-001", [1, 1], [60, 60], withStrategy(root, { onboardComputeExpansionsPerTick: perTick })), tick);

  it("falls back on budget_exceeded; the completion tick is the summed charge, over the per-tick budget", () => {
    const o = run(new PlanningService(workloadGrid()));
    expect(o.strategy?.searches.map((s) => [s.algorithm, s.result])).toEqual([["astar", "budget_exceeded"], ["hpa", "found"]]);
    expect(o.status).toBe("found");
    const [first, second] = o.strategy?.searches ?? [];
    expect(first?.expansions).toBe(100);
    expect(o.expansionsCharged).toBe(100 + (second?.expansions ?? 0));
    expect(o.completedTick).toBe(o.submittedTick + Math.ceil(o.expansionsCharged / 300) - 1);
  });

  it("a stage that ends with budget left lets the next stage start in the same tick", () => {
    const o = run(new PlanningService(workloadGrid()), 1, 1_000_000);
    expect(o.completedTick).toBe(o.submittedTick);
    expect(o.strategy?.searches.map((s) => [s.startedTick, s.endedTick])).toEqual([[1, 1], [1, 1]]);
  });

  it("a stage that fails exactly on the tick's budget ends in the next tick, cold or warm (one rule for both)", () => {
    // A*'s 100 expansions are exactly one tick. A search that ends without a path is noticed by the call after its last
    // expansion, so the stage ends in tick 2 and hpa starts there; a cached stage must end on the same tick.
    for (const warm of [false, true]) {
      const grid = workloadGrid();
      const service = new PlanningService(grid);
      if (warm) run(service, 1, 100);
      const o = run(service, warm ? 500 : 1, 100);
      expect(o.cacheHit).toBe(warm);
      const t = o.submittedTick;
      expect(o.strategy?.searches[0], `warm ${warm}`).toMatchObject({ startedTick: t, endedTick: t + 1 });
      expect(o.strategy?.searches[1]?.startedTick).toBe(t + 1);
    }
  });

  it("is identical with caches on and off, and warm = cold (same path, charge, completion tick)", () => {
    const grid = workloadGrid();
    const off = run(new PlanningService(grid, { cachesEnabled: false }));
    const warmService = new PlanningService(grid, { cachesEnabled: true });
    const cold = run(warmService);
    const warm = run(warmService, 200);
    expect(semantic(cold)).toEqual(semantic(off));
    expect(cold.cacheHit).toBe(false);
    expect(warm.cacheHit).toBe(true);
    expect(warm.completedTick - warm.submittedTick).toBe(cold.completedTick - cold.submittedTick);
    expect({ ...semantic(warm), queryId: "", submittedTick: 0, completedTick: 0 }).toEqual({ ...semantic(cold), queryId: "", submittedTick: 0, completedTick: 0 });
    expect(warm.strategy?.searches.map((s) => [s.expansions, s.result])).toEqual(cold.strategy?.searches.map((s) => [s.expansions, s.result]));
  });

  it("totalBudget caps the sum across stages: the query ends budget_exceeded with exactly the total charged", () => {
    const o = run(new PlanningService(workloadGrid()));
    const total = 100 + (o.strategy?.searches[1]?.expansions ?? 0);
    const capped = solve(new PlanningService(workloadGrid()), req("ugv-001", [1, 1], [60, 60], withStrategy(root, { totalBudget: total - 10 })));
    expect(capped.status).toBe("budget_exceeded");
    expect(capped.expansionsCharged).toBe(total - 10);
    expect(capped.strategy?.searches.map((s) => s.result)).toEqual(["budget_exceeded", "budget_exceeded"]);
  });

  it("a failure is the reason of the last search that ran", () => {
    const g = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 });
    for (let j = 0; j < 64; j++) g.setCell("occupancy", 32, j, 1); // a wall across the map: unreachable
    const o = solve(new PlanningService(g), req("ugv-001", [5, 5], [60, 5], withStrategy(node({ kind: "fallback", stages: [algo("astar"), algo("dijkstra")] }))));
    expect(o.status).toBe("not_found");
    expect(o.strategy?.searches.map((s) => s.result)).toEqual(["not_found", "not_found"]);
  });
});

describe("anytime", () => {
  const root = node({ kind: "anytime", weights: [3, 2, 1.5, 1] });
  it("runs the passes in order and returns the best completed path, the optimal one for a last weight of 1", () => {
    const grid = workloadGrid();
    const o = solve(new PlanningService(grid), req("ugv-001", [1, 1], [60, 60], withStrategy(root)));
    expect(o.status).toBe("found");
    expect(o.strategy?.searches.map((s) => s.weight)).toEqual([3, 2, 1.5, 1]);
    const view = new PlanningService(grid).view(undefined, UGV, cfg());
    if (!view.ok) throw new Error("no view");
    expect(o.cost).toBeCloseTo(referenceCost(view.value, 1 * 64 + 1, 60 * 64 + 60), 8);
    expect(isValidPath(view.value, o.cells)).toBe(true);
    expect(o.expansionsCharged).toBe((o.strategy?.searches ?? []).reduce((a, s) => a + s.expansions, 0));
  });

  it("returns its best path when the budget runs out during a later pass", () => {
    const grid = workloadGrid();
    const full = solve(new PlanningService(grid), req("ugv-001", [1, 1], [60, 60], withStrategy(root)));
    const first = full.strategy?.searches[0]?.expansions ?? 0;
    const second = full.strategy?.searches[1]?.expansions ?? 0;
    expect(first).toBeGreaterThan(100); // the numbers below need passes that are worth cutting
    expect(second).toBeGreaterThan(10);
    const cut = solve(new PlanningService(grid), req("ugv-001", [1, 1], [60, 60], withStrategy(root, { totalBudget: first + Math.floor(second / 2), onboardComputeExpansionsPerTick: 100 })));
    expect(cut.status).toBe("found"); // the first pass completed: that is the best so far
    expect(cut.strategy?.searches.at(-1)?.result).toBe("budget_exceeded");
    const none = solve(new PlanningService(grid), req("ugv-001", [1, 1], [60, 60], withStrategy(root, { totalBudget: 100, onboardComputeExpansionsPerTick: 100 }))); // the first pass needs more than 100
    expect(none.status).toBe("budget_exceeded");
  });
});

describe("refine (eager)", () => {
  const hpaThenAstar = node({ kind: "refine", mode: "eager", coarse: algo("hpa"), local: algo("astar") });
  it("plans the coarse path, then every leg, and returns one valid path whose cost is the sum of the legs", () => {
    const grid = workloadGrid();
    const o = solve(new PlanningService(grid), req("ugv-001", [1, 1], [60, 60], withStrategy(hpaThenAstar)));
    expect(o.status).toBe("found");
    const roles = (o.strategy?.searches ?? []).map((s) => s.role);
    expect(roles[0]).toBe("coarse");
    expect(roles.slice(1).every((r) => r === "leg")).toBe(true);
    expect(roles.length).toBeGreaterThan(2);
    const view = new PlanningService(grid).view(undefined, UGV, cfg());
    if (!view.ok) throw new Error("no view");
    expect(isValidPath(view.value, o.cells)).toBe(true);
    expect(o.cells[0]).toBe(1 * 64 + 1);
    expect(o.cells.at(-1)).toBe(60 * 64 + 60);
    expect(o.cost).toBeGreaterThanOrEqual(referenceCost(view.value, 1 * 64 + 1, 60 * 64 + 60) - 1e-9);
    expect(o.expansionsCharged).toBe((o.strategy?.searches ?? []).reduce((a, s) => a + s.expansions, 0));
  });

  it("a coarse leaf that is not hpa works too (its smoothed path gives the waypoints)", () => {
    const grid = workloadGrid();
    const o = solve(new PlanningService(grid), req("ugv-001", [1, 1], [60, 60], withStrategy(node({ kind: "refine", mode: "eager", coarse: algo("weighted-astar", { weight: 5 }), local: algo("astar") }))));
    expect(o.status).toBe("found");
    expect(o.strategy?.searches[0]).toMatchObject({ role: "coarse", algorithm: "weighted-astar" });
  });

  it("is identical with caches on and off and warm = cold", () => {
    const grid = workloadGrid();
    const off = solve(new PlanningService(grid, { cachesEnabled: false }), req("ugv-001", [1, 1], [60, 60], withStrategy(hpaThenAstar)));
    const s = new PlanningService(grid);
    const cold = solve(s, req("ugv-001", [1, 1], [60, 60], withStrategy(hpaThenAstar)));
    const warm = solve(s, req("ugv-001", [1, 1], [60, 60], withStrategy(hpaThenAstar)), 300);
    expect(semantic(cold)).toEqual(semantic(off));
    expect(warm.cacheHit).toBe(true);
    expect(warm.completedTick - warm.submittedTick).toBe(cold.completedTick - cold.submittedTick);
  });

  it("a lazy refine query is accepted by the service (its legs are read with takeLegs; the run start still refuses it until M3 ends)", () => {
    const s = new PlanningService(workloadGrid());
    const r = s.submit(req("ugv-001", [1, 1], [60, 60], withStrategy(node({ kind: "refine", mode: "lazy", coarse: algo("hpa"), local: algo("astar") }))), 1);
    expect(r.ok).toBe(true);
  });
});

describe("a map change under a strategy (ADR-0037 addition, items 1 and 7)", () => {
  const root = node({ kind: "fallback", stages: [algo("astar", { stageBudget: 400 }), algo("weighted-astar", { weight: 2 })] });
  // 250 per tick: stage 1 (astar, capped at 400) ends inside tick 2 and stage 2 starts there with budget left.
  const long = () => req("ugv-001", [1, 1], [60, 60], withStrategy(root, { onboardComputeExpansionsPerTick: 250 }));

  it("restarts from the root when a chunk that a completed stage read changes, and counts what it spent", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    expect(s.submit(long(), 1).ok).toBe(true);
    s.tick(1);
    s.tick(2); // stage 1 (astar, 400) is done; stage 2 is running
    grid.setCell("occupancy", 3, 3, 1); // next to the start: a chunk stage 1 certainly read
    let o: PlanOutcome | undefined;
    for (let t = 3; t < 400 && !o; t++) {
      s.tick(t);
      o = s.takeCompleted()[0];
    }
    const restarts = s.takeRestarts();
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject({ agentId: "ugv-001", reason: "read_set_overlap" });
    expect(restarts[0]?.spent).toBeGreaterThanOrEqual(400); // stage 1's charge counts
    expect(o?.restarts).toBe(1);
    expect(o?.status).toBe("found");
    expect(o?.expansionsCharged).toBeGreaterThan(restarts[0]?.spent ?? 0);
    // The second attempt re-evaluated the strategy from the root: its search list starts with astar again.
    expect(o?.strategy?.searches[0]?.algorithm).toBe("astar");
  });

  it("continues when the change is in a chunk no stage has read, and the result equals a cold run on the final map", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    expect(s.submit(long(), 1).ok).toBe(true);
    s.tick(1);
    grid.setCell("occupancy", 62, 2, 1); // far corner, chunk (3, 0): not read by a search that has expanded 200 cells near (1, 1)
    let o: PlanOutcome | undefined;
    for (let t = 2; t < 400 && !o; t++) {
      s.tick(t);
      o = s.takeCompleted()[0];
    }
    expect(s.takeRestarts()).toHaveLength(0);
    expect(o?.restarts).toBe(0);
    expect(o?.continuations).toBeGreaterThanOrEqual(1);
    const cold = solve(new PlanningService(grid, { cachesEnabled: false }), long(), 1);
    expect(o?.cells).toEqual(cold.cells);
    expect(o?.expansionsCharged).toBe(cold.expansionsCharged);
  });

  it("an hpa stage restarts the query when the abstract graph changes, even far from where it searched", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const q = req("ugv-001", [1, 1], [60, 60], withStrategy(node({ kind: "fallback", stages: [algo("astar", { stageBudget: 50 }), algo("hpa")] }), { onboardComputeExpansionsPerTick: 100 }));
    expect(s.submit(q, 1).ok).toBe(true);
    s.tick(1);
    s.tick(2); // the hpa stage is running
    for (let j = 40; j < 50; j++) grid.setCell("occupancy", 40, j, 1); // changes the abstract graph somewhere in the middle
    let o: PlanOutcome | undefined;
    for (let t = 3; t < 500 && !o; t++) {
      s.tick(t);
      o = s.takeCompleted()[0];
    }
    expect(s.takeRestarts().some((r) => r.reason === "graph_changed" || r.reason === "read_set_overlap")).toBe(true);
    expect(o?.restarts).toBeGreaterThanOrEqual(1);
  });

  it("re-evaluates the conditions on a restart (replan.count) and recomputes the context from the map as it is", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const sel = node({ kind: "select", branches: [{ when: "replan.count >= 1", then: algo("dijkstra") }], else: algo("astar") });
    expect(s.submit(req("ugv-001", [1, 1], [60, 60], withStrategy(sel, { onboardComputeExpansionsPerTick: 100 })), 1).ok).toBe(true);
    s.tick(1);
    grid.setCell("occupancy", 3, 3, 1);
    let o: PlanOutcome | undefined;
    for (let t = 2; t < 2000 && !o; t++) {
      s.tick(t);
      o = s.takeCompleted()[0];
    }
    expect(o?.restarts).toBe(1);
    expect(o?.strategy?.selects).toEqual([{ path: "/root", branch: 0, values: { "replan.count": 1 } }]);
    expect(o?.strategy?.searches[0]?.algorithm).toBe("dijkstra");
  });

  it("the cumulative totalBudget stops a query that keeps being restarted (the starvation bound)", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    expect(s.submit(req("ugv-001", [1, 1], [60, 60], withStrategy(node({ kind: "fallback", stages: [algo("astar"), algo("dijkstra")] }), { onboardComputeExpansionsPerTick: 200, totalBudget: 1500 })), 1).ok).toBe(true);
    let o: PlanOutcome | undefined;
    for (let t = 1; t < 200 && !o; t++) {
      grid.setCell("occupancy", 2 + (t % 3), 2, t % 2 === 0 ? 1 : 0); // keeps changing a chunk next to the start
      s.tick(t);
      o = s.takeCompleted()[0];
    }
    expect(o?.status).toBe("budget_exceeded");
    expect(o?.expansionsCharged).toBeLessThanOrEqual(1500 + 200);
    expect(o?.restarts).toBeGreaterThanOrEqual(2);
  });
});

describe("agents with different strategies do not affect each other", () => {
  it("each follows its own tree and budget: an agent's outcome is the same alone or with others planning", () => {
    const grid = workloadGrid();
    const a = req("ugv-001", [1, 1], [60, 60], withStrategy(node({ kind: "fallback", stages: [algo("astar", { stageBudget: 100 }), algo("hpa")] })));
    const b = req("ugv-002", [2, 60], [60, 2], withStrategy(node({ kind: "anytime", weights: [3, 1] }), { onboardComputeExpansionsPerTick: 150 }));
    const c = req("ugv-003", [5, 5], [6, 50], cfg({ algorithm: { kind: "dijkstra" } }));
    const alone = solve(new PlanningService(grid), a);
    const together = new PlanningService(grid);
    for (const r of [a, b, c]) expect(together.submit(r, 1).ok).toBe(true);
    const done: PlanOutcome[] = [];
    for (let t = 1; t < 3000 && done.length < 3; t++) {
      together.tick(t);
      done.push(...together.takeCompleted());
    }
    const mine = done.find((o) => o.agentId === "ugv-001");
    expect(mine && semantic(mine)).toEqual(semantic(alone));
    expect(done.find((o) => o.agentId === "ugv-002")?.strategy?.searches[0]?.weight).toBe(3);
    expect(done.find((o) => o.agentId === "ugv-003")?.strategy).toBeUndefined();
  });
});

describe("snapshot and restore (ADR-0037 addition, item 9; service level, World restore is F3)", () => {
  const strategies: [string, StrategyNode, number][] = [
    ["fallback, mid first stage", node({ kind: "fallback", stages: [algo("astar", { stageBudget: 300 }), algo("hpa")] }), 2],
    ["fallback, mid second stage", node({ kind: "fallback", stages: [algo("astar", { stageBudget: 100 }), algo("hpa")] }), 2],
    ["anytime, between passes", node({ kind: "anytime", weights: [3, 2, 1] }), 3],
    ["refine, mid legs", node({ kind: "refine", mode: "eager", coarse: algo("hpa"), local: algo("astar") }), 3],
    ["select inside fallback", node({ kind: "fallback", stages: [algo("astar", { stageBudget: 60 }), node({ kind: "select", branches: [{ when: "dist.m > 10", then: algo("dijkstra") }], else: algo("astar") })] }), 2],
  ];
  for (const [name, root, snapTick] of strategies) {
    for (const cachesEnabled of [true, false]) {
      it(`${name}: a restored service finishes with the same outcome as the uninterrupted one (caches ${cachesEnabled ? "on" : "off"})`, () => {
        const grid = workloadGrid();
        const q = req("ugv-001", [1, 1], [60, 60], withStrategy(root, { onboardComputeExpansionsPerTick: 100 }));
        const a = new PlanningService(grid, { cachesEnabled: true });
        expect(a.submit(q, 1).ok).toBe(true);
        for (let t = 1; t <= snapTick; t++) a.tick(t);
        const snap = a.snapshot();
        expect(snap.active).toHaveLength(1);
        let finished: PlanOutcome | undefined;
        for (let t = snapTick + 1; t < 3000 && !finished; t++) {
          a.tick(t);
          finished = a.takeCompleted()[0];
        }
        const b = new PlanningService(grid, { cachesEnabled });
        b.restore(JSON.parse(JSON.stringify(snap)));
        let restored: PlanOutcome | undefined;
        for (let t = snapTick + 1; t < 3000 && !restored; t++) {
          b.tick(t);
          restored = b.takeCompleted()[0];
        }
        expect(finished?.status).toBe("found");
        expect(restored && { ...semantic(restored), cacheHit: undefined }).toEqual(finished && { ...semantic(finished), cacheHit: undefined });
        expect(JSON.stringify(restored?.strategy)).toBe(JSON.stringify(finished?.strategy)); // the strategy trace too, ticks included
      });
    }
  }

  it("a restart behind the snapshot is restored too: the replan count and the spent charge carry over", () => {
    const grid = workloadGrid();
    const root = node({ kind: "select", branches: [{ when: "replan.count >= 1", then: algo("dijkstra") }], else: algo("astar") });
    const a = new PlanningService(grid, { cachesEnabled: false });
    expect(a.submit(req("ugv-001", [1, 1], [60, 60], withStrategy(root, { onboardComputeExpansionsPerTick: 100 })), 1).ok).toBe(true);
    a.tick(1);
    grid.setCell("occupancy", 3, 3, 1);
    a.tick(2);
    a.tick(3);
    expect(a.takeRestarts()).toHaveLength(1);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    expect(snap.active[0].restarts).toBe(1);
    let finished: PlanOutcome | undefined;
    for (let t = 4; t < 3000 && !finished; t++) {
      a.tick(t);
      finished = a.takeCompleted()[0];
    }
    const b = new PlanningService(grid, { cachesEnabled: false });
    b.restore(snap);
    let restored: PlanOutcome | undefined;
    for (let t = 4; t < 3000 && !restored; t++) {
      b.tick(t);
      restored = b.takeCompleted()[0];
    }
    expect(restored?.restarts).toBe(1);
    expect(restored?.strategy?.selects).toEqual(finished?.strategy?.selects);
    expect(restored && semantic(restored)).toEqual(finished && semantic(finished));
  });
});

describe("planning views for strategies", () => {
  it("prepare builds the abstract graph for a strategy that has an hpa leaf, so nothing is built inside a tick", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const prepared = s.prepare([{ traversal: UGV, config: withStrategy(node({ kind: "fallback", stages: [algo("astar", { stageBudget: 10 }), algo("hpa")] })) }]);
    expect(prepared.ok && prepared.value.graphs).toBe(1);
    const noHpa = new PlanningService(grid).prepare([{ traversal: UGV, config: withStrategy(algo("astar")) }]);
    expect(noHpa.ok && noHpa.value.graphs).toBe(0);
    const before = s.diagnostics.graphsBuilt;
    solve(s, req("ugv-001", [1, 1], [60, 60], withStrategy(node({ kind: "fallback", stages: [algo("astar", { stageBudget: 10 }), algo("hpa")] }))));
    expect(s.diagnostics.graphsBuilt).toBe(before);
  });

  it("validates a strategy against the agent's budgets and profile like a plain configuration", () => {
    const s = new PlanningService(workloadGrid());
    const over = s.submit(req("ugv-001", [1, 1], [60, 60], withStrategy(algo("astar", { stageBudget: 5000 }), { totalBudget: 4000 })), 1);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("stage_budget_exceeds_total");
    const turn = s.submit(req("ugv-001", [1, 1], [60, 60], withStrategy(algo("hpa"), { costProfile: { weights: { distance: 1, turn: 1 } } })), 1);
    expect(turn.ok).toBe(false);
    if (!turn.ok) expect(turn.error.code).toBe("profile_feature_unsupported");
  });
});

describe("the geometry of each search in the strategy trace (ADR-0037 seventh addition, item 14)", () => {
  const refineEager = node({ kind: "refine", mode: "eager", coarse: algo("hpa"), local: algo("astar") });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  it("records the smoothed path of every found search in metres, rounded to 1 cm, from the search's start to its end", () => {
    const o = solve(new PlanningService(workloadGrid()), req("ugv-001", [1, 1], [60, 60], withStrategy(refineEager)));
    const searches = o.strategy?.searches ?? [];
    expect(searches.length).toBeGreaterThan(2);
    for (const s of searches) {
      expect(s.result).toBe("found");
      expect(s.waypoints?.length, s.path).toBeGreaterThanOrEqual(2);
      for (const [x, y] of s.waypoints ?? []) {
        expect(near(x * 100, Math.round(x * 100)), `${s.path} x ${x}`).toBe(true);
        expect(near(y * 100, Math.round(y * 100)), `${s.path} y ${y}`).toBe(true);
      }
    }
    // The coarse search runs from the query's start to its goal; the legs join up, the first at the start, the last at the goal.
    const [coarse, ...legs] = searches;
    expect(coarse?.role).toBe("coarse");
    expect(coarse?.waypoints?.[0]).toEqual([1.5, 1.5]);
    expect(coarse?.waypoints?.at(-1)).toEqual([60.5, 60.5]);
    expect(legs[0]?.waypoints?.[0]).toEqual([1.5, 1.5]);
    expect(legs.at(-1)?.waypoints?.at(-1)).toEqual([60.5, 60.5]);
    for (let k = 1; k < legs.length; k++) expect(legs[k]?.waypoints?.[0]).toEqual(legs[k - 1]?.waypoints?.at(-1));
  });

  it("a search that did not find a path has no geometry, and a plain query has no strategy trace at all", () => {
    const g = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 });
    for (let j = 0; j < 64; j++) g.setCell("occupancy", 32, j, 1);
    const o = solve(new PlanningService(g), req("ugv-001", [5, 5], [60, 5], withStrategy(node({ kind: "fallback", stages: [algo("astar"), algo("dijkstra")] }))));
    expect(o.strategy?.searches.every((s) => s.waypoints === undefined)).toBe(true);
    expect(solve(new PlanningService(workloadGrid()), req("ugv-001", [1, 1], [60, 60])).strategy).toBeUndefined();
  });

  it("is the same warm as cold, and thinned to at most 128 points", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    const cold = solve(s, req("ugv-001", [1, 1], [60, 60], withStrategy(refineEager)));
    const warm = solve(s, req("ugv-001", [1, 1], [60, 60], withStrategy(refineEager)), 300);
    expect(warm.cacheHit).toBe(true);
    const untimed = (o: PlanOutcome) => JSON.stringify(o.strategy?.searches.map((x) => ({ ...x, startedTick: 0, endedTick: 0 }))); // the warm query was submitted later
    expect(untimed(warm)).toBe(untimed(cold));
    for (const x of cold.strategy?.searches ?? []) expect(x.waypoints?.length ?? 0).toBeLessThanOrEqual(128);
    // A long open route is thinned: a straight line across a big empty map would otherwise have far more than 128 cells.
    const big = new GridSpace({ sizeX: 600, sizeY: 600, resolutionM: 0.25, chunkSize: 64 });
    const o = solve(new PlanningService(big), { ...req("ugv-001", [1, 1], [1, 1], cfg({ strategy: { id: "t", version: 1, hash: "0", root: algo("dijkstra") }, onboardComputeExpansionsPerTick: 1_000_000 })), from: { x: 1.125, y: 1.125 }, to: { x: 148.875, y: 148.875 } });
    expect(o.strategy?.searches[0]?.waypoints?.length).toBeGreaterThanOrEqual(2);
    expect(o.strategy?.searches[0]?.waypoints?.length).toBeLessThanOrEqual(128);
  });
});

describe("planning on a snapshot copy of a belief grid (F2b M4 sandbox, ADR-0037 item 16)", () => {
  it("a separate service over the copy returns the outcome of the run's service at the moment of copying, and ignores later changes", () => {
    const world = new GridSpace({ sizeX: 60, sizeY: 60, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 60 } });
    const belief = new BeliefMap(world.sizeX, world.sizeY, world.chunkSize);
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) belief.observeFree(i, j, 25);
    for (let j = 10; j < 50; j++) for (let k = 0; k < 2; k++) belief.observeHit(30, j, 2, 30);
    const grid = new BeliefGrid(missionOf(world), belief);
    const root = node({ kind: "fallback", stages: [algo("astar", { stageBudget: 100 }), algo("hpa")] });
    const request = { ...req("scout", [2, 2], [58, 58], withStrategy(root)), mapKey: "scout" };
    const live = new PlanningService(world, { mapFor: (k) => (k === "scout" ? grid : undefined) });
    const copy = grid.snapshotCopy();
    const sandbox = new PlanningService(world, { cachesEnabled: false, mapFor: (k) => (k === "scout" ? copy : undefined) });
    const expected = solve(live, request);
    // The run's map keeps changing; the copy does not follow.
    for (let j = 0; j < 60; j++) for (let k = 0; k < 2; k++) belief.observeHit(45, j, 2, 30);
    const got = solve(sandbox, request);
    expect(got.status).toBe(expected.status);
    expect(got.waypoints).toEqual(expected.waypoints);
    expect(got.strategy).toEqual(expected.strategy);
    expect(got.completedTick).toBe(expected.completedTick);
  });
});
