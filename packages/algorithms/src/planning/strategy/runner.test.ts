import { describe, expect, it } from "vitest";
import { buildConditionValues, StrategyRunner, type ConditionValues, type LegReady, type StageFeedback, type StageResult, type StageSpec, type StrategyTrace } from "./runner.ts";
import type { StrategyNode } from "./schema.ts";

// Pure tests of the stage runner (ADR-0037): the tree decides which search runs next from the results it is given.
// A scripted "executor" plays the part of the service.

const SX = 100; // grid width for cell <-> (i, j)
const cell = (i: number, j: number) => j * SX + i;
const algo = (algorithm: string, extra: Record<string, unknown> = {}) => ({ kind: "algorithm", algorithm, ...extra }) as unknown as StrategyNode;
const ctx = (over: Partial<{ distM: number; vehicle: "uav" | "ugv"; altitudeM: number; totalBudget: number; replanCount: number; knownFrac: number }> = {}): ConditionValues =>
  buildConditionValues({ distM: 50, vehicle: "ugv", altitudeM: 0, profileWeights: { distance: 1, time: 0, energy: 0, terrain: 0, turn: 0, unknown: 1 }, totalBudget: 100_000, replanCount: 0, knownFrac: 1, ...over });
const at = (a: readonly number[], i: number): number => a[i] ?? 0;

const found = (cells: number[], cost = cells.length, expansions = 10): StageResult => ({ status: "found", cells, cost, expansions });
const failed = (status: "not_found" | "budget_exceeded", expansions = 5): StageResult => ({ status, cells: [], cost: Number.POSITIVE_INFINITY, expansions });

interface Run {
  readonly specs: StageSpec[];
  /** Legs published by a lazy refine, with the number of searches that had completed when each became ready. */
  readonly legs: (LegReady & { readonly afterSearch: number })[];
  readonly outcome: ReturnType<StrategyRunner["outcome"]>;
  readonly trace: StrategyTrace;
}
/** Drives a runner: `answer(spec, n)` gives the result of the n-th requested search. */
function drive(root: StrategyNode, answer: (spec: StageSpec, n: number) => StageResult, opts: { context?: ConditionValues; from?: number; to?: number; startDir?: number; total?: number; waypointsOf?: (c: readonly number[]) => number[] } = {}): Run {
  const runner = new StrategyRunner({
    strategy: { id: "t", version: 1, hash: "00000000", root },
    context: opts.context ?? ctx(),
    from: opts.from ?? cell(0, 0),
    to: opts.to ?? cell(9, 0),
    ...(opts.startDir === undefined ? {} : { startDir: opts.startDir }),
    sizeX: SX,
    deps: { waypointsOf: opts.waypointsOf ?? ((c) => [...c]) },
  });
  const specs: StageSpec[] = [];
  const legs: (LegReady & { afterSearch: number })[] = [];
  let remaining = opts.total ?? 1_000_000;
  for (let spec = runner.current(); spec !== undefined; spec = runner.current()) {
    specs.push(spec);
    const result = answer(spec, specs.length - 1);
    remaining -= result.expansions;
    const fb: StageFeedback = { result, remainingAfter: remaining, startedTick: specs.length - 1, endedTick: specs.length };
    runner.complete(fb);
    for (const l of runner.drainLegs()) legs.push({ ...l, afterSearch: specs.length });
    if (specs.length > 500) throw new Error("runaway");
  }
  const outcome = runner.outcome();
  return { specs, legs, outcome, trace: runner.trace() };
}

describe("a single algorithm leaf", () => {
  it("asks for its search once and returns its result", () => {
    const r = drive(algo("astar", { heuristic: "euclidean", stageBudget: 777 }), () => found([1, 2, 3], 2));
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]).toMatchObject({ path: "/root", algorithm: "astar", heuristic: "euclidean", stageBudget: 777, from: cell(0, 0), to: cell(9, 0), coarseOnly: false });
    expect(r.outcome).toEqual({ status: "found", cells: [1, 2, 3], cost: 2 });
  });
  it("defaults to the octile heuristic and passes weights and the start heading on", () => {
    const r = drive(algo("weighted-astar", { weight: 2.5 }), () => found([1]), { startDir: 3 });
    expect(r.specs[0]).toMatchObject({ algorithm: "weighted-astar", weight: 2.5, heuristic: "octile", startDir: 3 });
  });
  it("returns the failure of the search that failed", () => {
    expect(drive(algo("hpa"), () => failed("not_found")).outcome?.status).toBe("not_found");
    expect(drive(algo("hpa"), () => failed("budget_exceeded")).outcome?.status).toBe("budget_exceeded");
  });
});

describe("fallback", () => {
  const root = { kind: "fallback", stages: [algo("astar", { stageBudget: 100 }), algo("hpa"), algo("dijkstra")] } as unknown as StrategyNode;
  it("goes to the next stage only after not_found or budget_exceeded", () => {
    const r1 = drive(root, (s) => (s.algorithm === "astar" ? failed("budget_exceeded") : found([4, 5])));
    expect(r1.specs.map((s) => s.algorithm)).toEqual(["astar", "hpa"]);
    expect(r1.outcome).toEqual({ status: "found", cells: [4, 5], cost: 2 });
    const r2 = drive(root, (s) => (s.algorithm === "astar" ? failed("not_found") : found([6])));
    expect(r2.specs.map((s) => s.algorithm)).toEqual(["astar", "hpa"]);
  });
  it("stops at the first stage that finds a path", () => {
    const r = drive(root, () => found([1, 2]));
    expect(r.specs.map((s) => s.algorithm)).toEqual(["astar"]);
  });
  it("returns the last stage's failure when every stage fails", () => {
    const r = drive(root, (s) => (s.algorithm === "dijkstra" ? failed("budget_exceeded") : failed("not_found")));
    expect(r.specs.map((s) => s.algorithm)).toEqual(["astar", "hpa", "dijkstra"]);
    expect(r.outcome?.status).toBe("budget_exceeded");
  });
  it("records every search with its place in the tree, its charge and its ticks", () => {
    const r = drive(root, (s) => (s.algorithm === "astar" ? failed("budget_exceeded", 100) : found([1], 1, 33)));
    expect(r.trace.searches).toEqual([
      { path: "/root/stages/0", role: "plan", algorithm: "astar", heuristic: "octile", stageBudget: 100, expansions: 100, result: "budget_exceeded", startedTick: 0, endedTick: 1 },
      { path: "/root/stages/1", role: "plan", algorithm: "hpa", heuristic: "octile", expansions: 33, result: "found", startedTick: 1, endedTick: 2 },
    ]);
  });
});

describe("select", () => {
  const root = {
    kind: "select",
    branches: [
      { when: "dist.m <= 200", then: algo("astar") },
      { when: 'vehicle == "uav" and known.frac > 0.5', then: algo("dijkstra") },
    ],
    else: algo("hpa"),
  } as unknown as StrategyNode;
  it("takes the first branch whose condition holds, else the else branch", () => {
    expect(drive(root, () => found([1]), { context: ctx({ distM: 150 }) }).specs[0]?.algorithm).toBe("astar");
    expect(drive(root, () => found([1]), { context: ctx({ distM: 900, vehicle: "uav", knownFrac: 0.9 }) }).specs[0]?.algorithm).toBe("dijkstra");
    expect(drive(root, () => found([1]), { context: ctx({ distM: 900, vehicle: "uav", knownFrac: 0.1 }) }).specs[0]?.algorithm).toBe("hpa");
    expect(drive(root, () => found([1]), { context: ctx({ distM: 900 }) }).specs[0]?.algorithm).toBe("hpa");
  });
  it("records the branch taken and the values of the variables the conditions use", () => {
    const r = drive(root, () => found([1]), { context: ctx({ distM: 900, vehicle: "uav", knownFrac: 0.9, replanCount: 4 }) });
    expect(r.trace.selects).toEqual([{ path: "/root", branch: 1, values: { "dist.m": 900, "known.frac": 0.9, vehicle: 0 } }]);
    const e = drive(root, () => found([1]), { context: ctx({ distM: 900 }) });
    expect(e.trace.selects[0]).toMatchObject({ path: "/root", branch: "else" });
  });
  it("evaluates a nested select when its node is entered, with the attempt's values", () => {
    const nested = { kind: "fallback", stages: [algo("astar"), { kind: "select", branches: [{ when: "replan.count >= 1", then: algo("dijkstra") }], else: algo("hpa") }] } as unknown as StrategyNode;
    const first = drive(nested, (s) => (s.algorithm === "astar" ? failed("not_found") : found([1])), { context: ctx({ replanCount: 0 }) });
    expect(first.specs.map((s) => s.algorithm)).toEqual(["astar", "hpa"]);
    const replanned = drive(nested, (s) => (s.algorithm === "astar" ? failed("not_found") : found([1])), { context: ctx({ replanCount: 2 }) });
    expect(replanned.specs.map((s) => s.algorithm)).toEqual(["astar", "dijkstra"]);
    expect(replanned.trace.selects[0]?.path).toBe("/root/stages/1");
  });
  it("builds the context from planner inputs only", () => {
    const c = ctx({ distM: 12.5 });
    expect(Object.keys(c).sort()).toEqual(
      ["altitude", "budget.total", "dist.m", "known.frac", "profile.distance", "profile.energy", "profile.terrain", "profile.time", "profile.turn", "profile.unknown", "replan.count", "vehicle"].sort(),
    );
    expect(c["profile.distance"]).toBe(1);
    expect(c["profile.time"]).toBe(0);
    expect(c["vehicle"]).toBe(1);
  });
});

describe("anytime", () => {
  const root = { kind: "anytime", weights: [3, 2, 1] } as unknown as StrategyNode;
  const costs = (...c: number[]) => (_s: StageSpec, n: number) => found([n, n + 100], c[n] ?? 99, 10);
  it("runs one weighted pass per weight, in order, and returns the best completed path", () => {
    const r = drive(root, costs(10, 8, 8.5));
    expect(r.specs.map((s) => [s.algorithm, s.weight])).toEqual([["weighted-astar", 3], ["weighted-astar", 2], ["weighted-astar", 1]]);
    expect(r.outcome).toEqual({ status: "found", cells: [1, 101], cost: 8 }); // pass 2 was the cheapest
  });
  it("returns the best so far when a later pass runs out of budget", () => {
    const r = drive(root, (s, n) => (n === 0 ? found([7, 8], 9) : failed("budget_exceeded", 40)));
    expect(r.specs).toHaveLength(2);
    expect(r.outcome).toEqual({ status: "found", cells: [7, 8], cost: 9 });
  });
  it("fails with the reason when no pass completed", () => {
    expect(drive(root, () => failed("budget_exceeded", 40)).outcome?.status).toBe("budget_exceeded");
    const r = drive(root, () => failed("not_found", 3));
    expect(r.outcome?.status).toBe("not_found");
    expect(r.specs).toHaveLength(1); // unreachable on the first pass means unreachable
  });
  it("its stageBudget caps the whole node: each pass gets what is left, and the node stops when it is spent", () => {
    const capped = { kind: "anytime", weights: [3, 2, 1.5, 1], stageBudget: 100 } as unknown as StrategyNode;
    const r = drive(capped, (s, n) => found([n], 10 - n, Math.min(40, s.stageBudget ?? 40))); // a pass never spends more than its cap
    expect(r.specs.map((s) => s.stageBudget)).toEqual([100, 60, 20]); // 40 + 40, then the 20 that are left
    expect(r.specs).toHaveLength(3); // the node's 100 are spent: no fourth pass
    expect(r.outcome?.status).toBe("found");
    const spentAll = drive(capped, (_s, n) => found([n], 10 - n, 100));
    expect(spentAll.specs).toHaveLength(1); // the first pass used the whole cap
    expect(spentAll.outcome).toEqual({ status: "found", cells: [0], cost: 10 });
  });
  it("a first pass that cannot finish under the node cap fails with budget_exceeded", () => {
    const capped = { kind: "anytime", weights: [2, 1], stageBudget: 50 } as unknown as StrategyNode;
    expect(drive(capped, () => failed("budget_exceeded", 50)).outcome?.status).toBe("budget_exceeded");
  });
});

describe("refine (eager)", () => {
  const refine = (coarse: unknown, local: unknown) => ({ kind: "refine", mode: "eager", coarse, local }) as unknown as StrategyNode;
  const W: [number, number, number, number] = [cell(0, 0), cell(10, 0), cell(10, 10), cell(20, 10)];
  const legPath = (a: number, b: number) => [a, b]; // a stand-in for a leg's cell path

  it("asks for the coarse path first (hpa stops after its abstract phase), then one local search per leg", () => {
    const r = drive(
      refine(algo("hpa"), algo("astar")),
      (s) => (s.role === "coarse" ? { ...found([], 30, 25), waypoints: W } : found(legPath(s.from, s.to), 10, 7)),
      { from: W[0], to: W[3] },
    );
    expect(r.specs[0]).toMatchObject({ path: "/root/coarse", role: "coarse", algorithm: "hpa", coarseOnly: true });
    const legs = r.specs.slice(1);
    expect(legs.map((s) => [s.role, s.from, s.to, s.algorithm])).toEqual([
      ["leg", W[0], W[1], "astar"],
      ["leg", W[1], W[2], "astar"],
      ["leg", W[2], W[3], "astar"],
    ]);
    expect(legs.map((s) => s.path)).toEqual(["/root/local[0]", "/root/local[1]", "/root/local[2]"]);
    expect(legs.every((s) => !s.coarseOnly)).toBe(true);
    // One path: the joint cell of two legs appears once; the cost is the sum.
    expect(r.outcome).toEqual({ status: "found", cells: [W[0], W[1], W[2], W[3]], cost: 30 });
  });

  it("a coarse leaf other than hpa runs as a normal search and its path is turned into waypoints by the caller's rule", () => {
    const calls: (readonly number[])[] = [];
    const r = drive(
      refine(algo("astar"), algo("dijkstra")),
      (s) => (s.role === "coarse" ? found([W[0], 5, 6, W[3]], 20, 100) : found(legPath(s.from, s.to), 4, 3)),
      {
        from: W[0],
        to: W[3],
        waypointsOf: (c) => {
          calls.push(c);
          return [at(c, 0), at(c, c.length - 1)]; // the smoothed path is one straight leg
        },
      },
    );
    expect(r.specs[0]).toMatchObject({ role: "coarse", algorithm: "astar", coarseOnly: false });
    expect(calls).toEqual([[W[0], 5, 6, W[3]]]);
    expect(r.specs.slice(1).map((s) => [s.from, s.to])).toEqual([[W[0], W[3]]]);
    expect(r.outcome).toEqual({ status: "found", cells: [W[0], W[3]], cost: 4 });
  });

  it("fails with the reason of the search that failed, coarse or leg", () => {
    const failCoarse = drive(refine(algo("hpa"), algo("astar")), () => failed("not_found"));
    expect(failCoarse.outcome?.status).toBe("not_found");
    expect(failCoarse.specs).toHaveLength(1);
    const failLeg = drive(refine(algo("hpa"), algo("astar")), (s) => (s.role === "coarse" ? { ...found([], 30, 25), waypoints: W } : s.from === W[1] ? failed("budget_exceeded") : found(legPath(s.from, s.to))), {
      from: W[0],
      to: W[3],
    });
    expect(failLeg.outcome?.status).toBe("budget_exceeded");
    expect(failLeg.specs.map((s) => s.role)).toEqual(["coarse", "leg", "leg"]); // the third leg is never planned
  });

  it("a leg's start heading is the heading of the previous leg's last move", () => {
    const r = drive(
      refine(algo("hpa"), algo("astar")),
      (s) => {
        if (s.role === "coarse") return { ...found([], 30, 25), waypoints: [cell(0, 0), cell(5, 5), cell(9, 5)] };
        // leg 0 ends moving south-east (+i, +j): direction 1 in the DIR table; leg 1 ends moving east: direction 0
        return s.from === cell(0, 0) ? found([cell(0, 0), cell(4, 4), cell(5, 5)], 7, 5) : found([cell(5, 5), cell(9, 5)], 4, 5);
      },
      { from: cell(0, 0), to: cell(9, 5), startDir: 6 },
    );
    expect(r.specs.filter((s) => s.role === "leg").map((s) => s.startDir)).toEqual([6, 1]);
  });

  it("start == goal is a one-cell path at zero cost without asking for legs", () => {
    const r = drive(refine(algo("hpa"), algo("astar")), (s) => ({ ...found([], 0, 3), waypoints: [s.from, s.from] }), { from: cell(3, 3), to: cell(3, 3) });
    expect(r.specs).toHaveLength(1);
    expect(r.outcome).toEqual({ status: "found", cells: [cell(3, 3)], cost: 0 });
  });

  it("thins more than 64 legs to at most 64, keeping the start and the goal, and says so in the trace", () => {
    const many = Array.from({ length: 201 }, (_, k) => cell(k % 90, Math.floor(k / 90))); // 200 legs
    const r = drive(refine(algo("hpa"), algo("astar")), (s) => (s.role === "coarse" ? { ...found([], 500, 40), waypoints: many } : found(legPath(s.from, s.to), 2, 2)), {
      from: at(many, 0),
      to: at(many, many.length - 1),
    });
    const legs = r.specs.filter((s) => s.role === "leg");
    expect(legs.length).toBeLessThanOrEqual(64);
    expect(legs.length).toBeGreaterThan(32);
    expect(legs[0]?.from).toBe(at(many, 0));
    expect(legs.at(-1)?.to).toBe(at(many, many.length - 1));
    expect(r.trace.thinned).toEqual({ legs: 200, kept: legs.length });
    expect(r.outcome?.status).toBe("found");
  });

  it("with fewer than 64 legs nothing is thinned", () => {
    const r = drive(refine(algo("hpa"), algo("astar")), (s) => (s.role === "coarse" ? { ...found([], 30, 25), waypoints: W } : found(legPath(s.from, s.to))), { from: W[0], to: W[3] });
    expect(r.trace.thinned).toBeUndefined();
  });

  it("runs a combinator as the local node (a select or fallback per leg), and as the coarse node", () => {
    const local = { kind: "fallback", stages: [algo("astar", { stageBudget: 9 }), algo("dijkstra")] };
    const r = drive(refine({ kind: "fallback", stages: [algo("hpa"), algo("astar")] }, local), (s) => {
      if (s.role === "coarse") return s.algorithm === "hpa" ? failed("budget_exceeded") : found([W[0], W[3]], 30, 5);
      return s.algorithm === "astar" ? failed("budget_exceeded", 9) : found(legPath(s.from, s.to));
    }, { from: W[0], to: W[3], waypointsOf: (c) => [...c] });
    expect(r.specs.map((s) => `${s.role}:${s.algorithm}`)).toEqual(["coarse:hpa", "coarse:astar", "leg:astar", "leg:dijkstra"]);
    expect(r.outcome?.status).toBe("found");
  });

});

describe("refine (lazy): the legs are made available as they complete (ADR-0037 fourth addition)", () => {
  const lazy = (coarse: unknown, local: unknown) => ({ kind: "refine", mode: "lazy", coarse, local }) as unknown as StrategyNode;
  const eager = (coarse: unknown, local: unknown) => ({ kind: "refine", mode: "eager", coarse, local }) as unknown as StrategyNode;
  const W: [number, number, number, number] = [cell(0, 0), cell(10, 0), cell(10, 10), cell(20, 10)];
  const leg = (a: number, b: number) => [a, b];
  const answer = (s: StageSpec) => (s.role === "coarse" ? { ...found([], 30, 25), waypoints: W } : found(leg(s.from, s.to), 10, 7));

  it("runs the same searches as eager and ends with the same path, cost and charge", () => {
    const l = drive(lazy(algo("hpa"), algo("astar")), answer, { from: W[0], to: W[3] });
    const e = drive(eager(algo("hpa"), algo("astar")), answer, { from: W[0], to: W[3] });
    expect(l.specs).toEqual(e.specs);
    expect(l.outcome).toEqual(e.outcome);
    expect(l.trace.searches).toEqual(e.trace.searches);
  });

  it("publishes each leg when its search completes: only that leg's cells, in order, the last one flagged", () => {
    const r = drive(lazy(algo("hpa"), algo("astar")), answer, { from: W[0], to: W[3] });
    expect(r.legs).toEqual([
      { index: 0, count: 3, cells: [W[0], W[1]], cost: 10, last: false, afterSearch: 2 },
      { index: 1, count: 3, cells: [W[1], W[2]], cost: 10, last: false, afterSearch: 3 },
      { index: 2, count: 3, cells: [W[2], W[3]], cost: 10, last: true, afterSearch: 4 },
    ]);
    // The final outcome is still the whole path, for a consumer that ignores legs.
    expect(r.outcome).toEqual({ status: "found", cells: [W[0], W[1], W[2], W[3]], cost: 30 });
  });

  it("publishes nothing for eager, and nothing before the coarse path is known", () => {
    expect(drive(eager(algo("hpa"), algo("astar")), answer, { from: W[0], to: W[3] }).legs).toEqual([]);
    const r = drive(lazy(algo("hpa"), algo("astar")), answer, { from: W[0], to: W[3] });
    expect(Math.min(...r.legs.map((l) => l.afterSearch))).toBeGreaterThan(1); // the first leg comes after the coarse search
  });

  it("a failing leg ends the query with its reason; the legs before it were published, none is flagged last", () => {
    const r = drive(lazy(algo("hpa"), algo("astar")), (s) => (s.role === "coarse" ? { ...found([], 30, 25), waypoints: W } : s.from === W[1] ? failed("not_found") : found(leg(s.from, s.to))), { from: W[0], to: W[3] });
    expect(r.outcome?.status).toBe("not_found");
    expect(r.legs.map((l) => [l.index, l.last])).toEqual([[0, false]]);
  });

  it("thins above 64 legs like eager, and says how many legs there are up front", () => {
    const many = Array.from({ length: 201 }, (_, k) => cell(k % 90, Math.floor(k / 90)));
    const r = drive(lazy(algo("hpa"), algo("astar")), (s) => (s.role === "coarse" ? { ...found([], 500, 40), waypoints: many } : found(leg(s.from, s.to), 2, 2)), { from: at(many, 0), to: at(many, many.length - 1) });
    expect(r.legs.length).toBeLessThanOrEqual(64);
    expect(r.legs.every((l) => l.count === r.legs.length)).toBe(true);
    expect(r.legs.at(-1)?.last).toBe(true);
    expect(r.trace.thinned).toEqual({ legs: 200, kept: r.legs.length });
  });

  it("start == goal publishes the one-cell path as its only, last leg", () => {
    const r = drive(lazy(algo("hpa"), algo("astar")), (s) => ({ ...found([], 0, 3), waypoints: [s.from, s.from] }), { from: cell(3, 3), to: cell(3, 3) });
    expect(r.legs).toEqual([{ index: 0, count: 1, cells: [cell(3, 3)], cost: 0, last: true, afterSearch: 1 }]);
  });

  it("a local combinator publishes the leg its node settled on", () => {
    const local = { kind: "fallback", stages: [algo("astar", { stageBudget: 9 }), algo("dijkstra")] };
    const r = drive(lazy(algo("hpa"), local), (s) => (s.role === "coarse" ? { ...found([], 30, 5), waypoints: [W[0], W[3]] } : s.algorithm === "astar" ? failed("budget_exceeded", 9) : found(leg(s.from, s.to), 4, 6)), { from: W[0], to: W[3] });
    expect(r.legs).toEqual([{ index: 0, count: 1, cells: [W[0], W[3]], cost: 4, last: true, afterSearch: 3 }]);
  });
});

describe("determinism", () => {
  it("the same inputs give the same requests, outcome and trace", () => {
    const root = { kind: "select", branches: [{ when: "dist.m < 100", then: { kind: "anytime", weights: [3, 1.5, 1] } }], else: algo("hpa") } as unknown as StrategyNode;
    const a = drive(root, (s, n) => found([n, n + 1], 10 - n, 12), { context: ctx({ distM: 40 }) });
    const b = drive(root, (s, n) => found([n, n + 1], 10 - n, 12), { context: ctx({ distM: 40 }) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
