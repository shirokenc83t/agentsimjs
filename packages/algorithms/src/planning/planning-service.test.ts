import { BeliefGrid, BeliefMap, GridSpace, missionOf, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { Rng } from "@agentsim/core";
import type { CostProfile } from "../cost-profile.ts";
import { clearSegment, polylineCost, smoothPath } from "../grid/smoothing.ts";
import { GridSearch } from "../grid/grid-search.ts";
import { randomGrid, space, UAV, UGV } from "../testing/fixtures.ts";
import { PlanningService, validatePlanningConfig, type PlanOutcome, type PlanningConfig, type PlanRequest } from "./planning-service.ts";

const cfg = (over: Partial<PlanningConfig> = {}): PlanningConfig => ({
  algorithm: { kind: "astar" },
  onboardComputeExpansionsPerTick: 300,
  totalBudget: 1_000_000,
  ...over,
});

const req = (agentId: string, from: [number, number], to: [number, number], config = cfg()): PlanRequest => ({
  agentId,
  traversal: UGV,
  config,
  from: { x: from[0] + 0.5, y: from[1] + 0.5 },
  to: { x: to[0] + 0.5, y: to[1] + 0.5 },
});

/** A scripted planning workload: submissions at fixed ticks, including repeats (cache hits) and HPA*. */
const SCRIPT: [number, PlanRequest][] = [
  [1, req("ugv-001", [1, 1], [60, 60])],
  [1, req("ugv-002", [2, 60], [60, 2], cfg({ algorithm: { kind: "hpa" } }))],
  [3, req("ugv-003", [5, 5], [6, 50], cfg({ algorithm: { kind: "weighted-astar", weight: 2 } }))],
  [9, req("ugv-001", [1, 1], [60, 60])], // repeat of the first query: a cache hit when caches are on
  [12, req("ugv-002", [2, 60], [60, 2], cfg({ algorithm: { kind: "hpa" } }))], // repeat
  [14, req("ugv-004", [30, 30], [1, 62], cfg({ algorithm: { kind: "dijkstra" } }))],
  [20, req("ugv-003", [5, 5], [6, 50], cfg({ algorithm: { kind: "weighted-astar", weight: 2 } }))], // repeat
];

function runScript(service: PlanningService, fromTick: number, toTick: number): PlanOutcome[] {
  const out: PlanOutcome[] = [];
  for (let t = fromTick; t <= toTick; t++) {
    for (const [at, r] of SCRIPT) if (at === t) expect(service.submit(r, t).ok).toBe(true);
    service.tick(t);
    out.push(...service.takeCompleted());
  }
  return out;
}

const semantic = (o: PlanOutcome) => ({ ...o, cacheHit: undefined });

/** Random 64×64 grid whose test endpoints are guaranteed free (obstacles elsewhere stay random). */
function workloadGrid(): GridSpace {
  const g = randomGrid(8, 64, 0.18, 16);
  const endpoints: [number, number][] = [[1, 1], [60, 60], [2, 60], [60, 2], [5, 5], [6, 50], [30, 30], [1, 62], [3, 3], [9, 9], [62, 62]];
  for (const [i, j] of endpoints) {
    g.setCell("occupancy", i, j, 0);
    g.setCell("terrainCost", i, j, 10);
  }
  return g;
}

describe("PlanningService (ADR-0024, ADR-0028)", () => {
  it("gives identical results and completion ticks with caches on and off", () => {
    const grid = workloadGrid();
    const on = runScript(new PlanningService(grid, { cachesEnabled: true }), 1, 80);
    const off = runScript(new PlanningService(grid, { cachesEnabled: false }), 1, 80);
    expect(on.length).toBe(SCRIPT.length);
    expect(on.map(semantic)).toEqual(off.map(semantic));
    expect(on.filter((o) => o.cacheHit).length).toBeGreaterThanOrEqual(2); // the repeats hit
    expect(off.some((o) => o.cacheHit)).toBe(false);
    for (const o of on) expect(o.completedTick).toBeGreaterThanOrEqual(o.submittedTick);
  });

  it("restores a mid-run snapshot (queries in progress) with identical outcomes, even with caches off", () => {
    const grid = workloadGrid();
    const a = new PlanningService(grid, { cachesEnabled: true });
    const before = runScript(a, 1, 10);
    const snap = a.snapshot();
    expect(snap.active.length).toBeGreaterThan(0); // something is mid-flight
    expect(snap.active.some((q) => q.charged > 0)).toBe(true);
    const after = runScript(a, 11, 80);
    const b = new PlanningService(grid, { cachesEnabled: false });
    b.restore(JSON.parse(JSON.stringify(snap)));
    const restored = runScript(b, 11, 80);
    expect(restored.map(semantic)).toEqual(after.map(semantic));
    expect(before.length + after.length).toBe(SCRIPT.length);
  });

  it("charges each agent only its own budget: a heavy query never delays another agent", () => {
    const grid = workloadGrid();
    const alone = new PlanningService(grid);
    alone.submit(req("ugv-002", [3, 3], [9, 9]), 1);
    let tAlone = 0;
    for (let t = 1; t < 50 && tAlone === 0; t++) {
      alone.tick(t);
      tAlone = alone.takeCompleted()[0]?.completedTick ?? 0;
    }
    const busy = new PlanningService(grid);
    busy.submit(req("ugv-001", [1, 1], [62, 62], cfg({ algorithm: { kind: "dijkstra" } })), 1); // heavy
    busy.submit(req("ugv-002", [3, 3], [9, 9]), 1);
    let tBusy = 0;
    for (let t = 1; t < 50 && tBusy === 0; t++) {
      busy.tick(t);
      tBusy = busy.takeCompleted().find((o) => o.agentId === "ugv-002")?.completedTick ?? 0;
    }
    expect(tBusy).toBe(tAlone);
  });

  it("completion tick follows the agent's onboard compute (sim-time planning latency)", () => {
    const grid = workloadGrid();
    const done = (perTick: number) => {
      const s = new PlanningService(grid);
      s.submit(req("ugv-001", [1, 1], [60, 60], cfg({ onboardComputeExpansionsPerTick: perTick })), 1);
      for (let t = 1; t < 10_000; t++) {
        s.tick(t);
        const o = s.takeCompleted()[0];
        if (o) return o;
      }
      throw new Error("no completion");
    };
    const slow = done(100);
    const fast = done(5000);
    expect(slow.expansionsCharged).toBe(fast.expansionsCharged);
    expect(slow.completedTick).toBe(Math.ceil(slow.expansionsCharged / 100));
    expect(fast.completedTick).toBeLessThan(slow.completedTick);
  });

  it("lets agents in the same run use different planners", () => {
    const grid = workloadGrid();
    const s = new PlanningService(grid);
    s.submit(req("uav-a", [1, 1], [60, 60], cfg({ algorithm: { kind: "astar" } })), 1);
    s.submit(req("uav-b", [1, 1], [60, 60], cfg({ algorithm: { kind: "hpa" } })), 1);
    const out: PlanOutcome[] = [];
    for (let t = 1; t < 200 && out.length < 2; t++) {
      s.tick(t);
      out.push(...s.takeCompleted());
    }
    const a = out.find((o) => o.agentId === "uav-a");
    const b = out.find((o) => o.agentId === "uav-b");
    expect(a?.status).toBe("found");
    expect(b?.status).toBe("found");
    expect(a?.expansionsCharged).not.toBe(b?.expansionsCharged);
    expect(b?.cost ?? 0).toBeGreaterThanOrEqual((a?.cost ?? 0) - 1e-9); // A* is optimal, HPA* near-optimal
  });

  it.each([
    // A wall far from what the search has read (Dijkstra, 100 expansions around the start): it continues.
    [32, 0, 1],
    // A wall through what it has read (next to the start): it restarts.
    [3, 1, 0],
  ])("a ground-truth change at x = %i mid-query: %i restart(s), %i continuation(s) (read-set rule, ADR-0024)", (x, restarts, continuations) => {
    const grid = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 });
    const s = new PlanningService(grid);
    s.submit(req("ugv-001", [1, 32], [62, 32], cfg({ algorithm: { kind: "dijkstra" }, onboardComputeExpansionsPerTick: 100 })), 1);
    s.tick(1);
    for (let j = 0; j < 60; j++) grid.setCell("occupancy", x, j, OCCUPANCY_BLOCKED); // wall appears mid-query
    let o: PlanOutcome | undefined;
    for (let t = 2; t < 1000 && !o; t++) {
      s.tick(t);
      o = s.takeCompleted()[0];
    }
    expect(o?.status).toBe("found");
    expect([o?.restarts, o?.continuations]).toEqual([restarts, continuations]);
    expect(o?.cells.some((c) => c % 64 === x && ((c / 64) | 0) < 60)).toBe(false); // plans on the new world either way
  });

  describe("prepare (ADR-0024: precomputed structures built at scenario load)", () => {
    const uavAt = (altitudeM: number) => ({ ...UAV, cruiseAltitudeM: altitudeM });

    it("builds each distinct view once, and an HPA* graph only for views some target plans with hpa", () => {
      const s = new PlanningService(workloadGrid());
      const r = s.prepare([
        { traversal: UGV, config: cfg() },
        { traversal: UGV, config: cfg({ algorithm: { kind: "hpa" } }) }, // same view: adds its graph
        { traversal: UGV, config: cfg({ onboardComputeExpansionsPerTick: 500 }) }, // budgets don't change the view
        { traversal: uavAt(20), config: cfg() },
        { traversal: UGV, config: cfg({ costProfile: { weights: { distance: 1, terrain: 2 } } }) }, // another profile
      ]);
      expect(r).toEqual({ ok: true, value: { views: 3, graphs: 1 } });
      expect(s.diagnostics).toEqual({ viewsBuilt: 3, graphsBuilt: 1 });
    });

    it("reports progress per distinct target, ending at done = total", () => {
      const s = new PlanningService(workloadGrid());
      const seen: [number, number][] = [];
      s.prepare([{ traversal: UGV, config: cfg({ algorithm: { kind: "hpa" } }) }, { traversal: uavAt(20), config: cfg() }], (done, total) => seen.push([done, total]));
      expect(seen).toEqual([[0, 2], [1, 2], [2, 2]]);
    });

    it("prepared views stay cached beyond the LRU size: later queries build nothing", () => {
      const s = new PlanningService(workloadGrid(), { viewCacheSize: 2 });
      const alts = [10, 20, 30, 40, 50, 60];
      s.prepare(alts.map((a) => ({ traversal: uavAt(a), config: cfg({ algorithm: { kind: "hpa" } }) })));
      const built = { ...s.diagnostics };
      for (const [k, a] of alts.entries()) {
        expect(s.submit({ ...req(`uav-${k}`, [1, 1], [60, 60], cfg({ algorithm: { kind: "hpa" } })), traversal: uavAt(a) }, 1).ok).toBe(true);
      }
      expect(s.diagnostics).toEqual(built);
    });

    it("rejects an invalid target with its code and builds nothing", () => {
      const s = new PlanningService(workloadGrid());
      const r = s.prepare([{ traversal: UGV, config: cfg({ onboardComputeExpansionsPerTick: 50 }) }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("budget_out_of_range");
      expect(s.diagnostics).toEqual({ viewsBuilt: 0, graphsBuilt: 0 });
    });

    it("does nothing with caches off (a test mode, not optimized)", () => {
      const s = new PlanningService(workloadGrid(), { cachesEnabled: false });
      expect(s.prepare([{ traversal: UGV, config: cfg({ algorithm: { kind: "hpa" } }) }])).toEqual({ ok: true, value: { views: 0, graphs: 0 } });
      expect(s.diagnostics).toEqual({ viewsBuilt: 0, graphsBuilt: 0 });
    });

    it("never changes results or completion ticks (prepared vs on first use vs caches off)", () => {
      const grid = workloadGrid();
      const prepared = new PlanningService(grid);
      prepared.prepare(SCRIPT.map(([, r]) => ({ traversal: r.traversal, config: r.config })));
      const a = runScript(prepared, 1, 80);
      const b = runScript(new PlanningService(grid), 1, 80);
      const c = runScript(new PlanningService(grid, { cachesEnabled: false }), 1, 80);
      expect(a.map(semantic)).toEqual(b.map(semantic));
      expect(a.map(semantic)).toEqual(c.map(semantic));
    });

    it("a prepared view still follows later grid edits (local rebuild on first use after the edit)", () => {
      const grid = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 });
      const s = new PlanningService(grid);
      const hpa = cfg({ algorithm: { kind: "hpa" }, onboardComputeExpansionsPerTick: 100_000 });
      s.prepare([{ traversal: UGV, config: hpa }]);
      for (let j = 0; j < 60; j++) grid.setCell("occupancy", 32, j, OCCUPANCY_BLOCKED);
      s.submit(req("ugv-001", [1, 32], [62, 32], hpa), 1);
      s.tick(1);
      const o = s.takeCompleted()[0];
      expect(o?.status).toBe("found");
      expect(o?.cells.some((c) => c % 64 === 32 && ((c / 64) | 0) < 60)).toBe(false);
      expect(s.diagnostics.graphsBuilt).toBe(1); // synced locally, not rebuilt
    });
  });

  describe("per-agent maps (F2: belief grids)", () => {
    const mk = () => {
      const world = new GridSpace({ sizeX: 64, sizeY: 64, resolutionM: 1, chunkSize: 16 });
      const maps = new Map<string, BeliefGrid>();
      const add = (key: string) => {
        const b = new BeliefMap(64, 64, 16);
        maps.set(key, new BeliefGrid(missionOf(world), b));
        return b;
      };
      const s = new PlanningService(world, { viewCacheSize: 1, mapFor: (k) => maps.get(k) });
      return { s, add };
    };
    const run = (s: PlanningService, t0: number) => {
      const out: PlanOutcome[] = [];
      for (let t = t0; t < t0 + 200; t++) {
        s.tick(t);
        out.push(...s.takeCompleted());
      }
      return out;
    };

    it("each agent plans on its own map: a wall one agent believes in does not exist for the other", () => {
      const { s, add } = mk();
      const a = add("a");
      add("b");
      for (let j = 0; j < 60; j++) a.observeHit(32, j, 0, 30); // only agent a believes in this wall
      s.submit({ ...req("ugv-a", [1, 32], [62, 32]), mapKey: "a" }, 1);
      s.submit({ ...req("ugv-b", [1, 32], [62, 32]), mapKey: "b" }, 1);
      const out = run(s, 1);
      const pa = out.find((o) => o.agentId === "ugv-a");
      const pb = out.find((o) => o.agentId === "ugv-b");
      expect(pa?.status).toBe("found");
      expect(pb?.status).toBe("found");
      expect(pa?.cells.some((c) => c % 64 === 32 && ((c / 64) | 0) < 60)).toBe(false); // around the believed wall
      expect(pb?.cost).toBeLessThan(pa?.cost ?? 0); // straight: cheaper than the detour (cell counts can tie)
    });

    it("agents never evict each other's views (the LRU is per map)", () => {
      const { s, add } = mk();
      for (const k of ["a", "b", "c"]) add(k);
      for (const k of ["a", "b", "c"]) s.submit({ ...req(`ugv-${k}`, [1, 1], [60, 60]), mapKey: k }, 1);
      run(s, 1);
      const built = s.diagnostics.viewsBuilt;
      for (const k of ["a", "b", "c"]) s.submit({ ...req(`ugv-${k}`, [1, 1], [50, 60]), mapKey: k }, 300);
      run(s, 300);
      expect(s.diagnostics.viewsBuilt).toBe(built);
    });

    it("a believed wall through what the query read restarts it; a log-odds step that keeps the state and unknown → free change nothing", () => {
      const { s, add } = mk();
      const a = add("a");
      a.observeFree(1, 33, 20);
      s.submit({ ...req("ugv-a", [1, 32], [62, 32], cfg({ algorithm: { kind: "dijkstra" }, onboardComputeExpansionsPerTick: 100 })), mapKey: "a" }, 1);
      s.tick(1);
      a.observeFree(1, 33, 20); // still free
      a.observeFree(2, 33, 20); // unknown → free, with the built-in unknown weight 1
      s.tick(2);
      for (let j = 0; j < 60; j++) a.observeHit(3, j, 0, 30); // a believed wall next to the start
      const out = run(s, 3);
      expect([out[0]?.restarts, out[0]?.continuations]).toEqual([1, 0]);
    });

    it("an unknown map key fails the query with invalid_map", () => {
      const { s } = mk();
      const r = s.submit({ ...req("ugv-x", [1, 1], [5, 5]), mapKey: "nope" }, 1);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_map");
    });
  });

  it.each([
    [cfg({ algorithm: { kind: "weighted-astar", weight: 11 } }), "weight_out_of_range"],
    [cfg({ onboardComputeExpansionsPerTick: 50 }), "budget_out_of_range"],
    [cfg({ onboardComputeExpansionsPerTick: 1000, totalBudget: 999 }), "budget_out_of_range"],
    [cfg({ totalBudget: 20_000_000 }), "budget_out_of_range"],
    [cfg({ algorithm: { kind: "hpa" }, costProfile: { weights: { distance: 1, turn: 1 } } }), "profile_feature_unsupported"],
    [cfg({ costProfile: { weights: { radioCoverage: 1 } } }), "profile_feature_unsupported"],
  ])("rejects invalid configs (%#) with a stable code", (c, code) => {
    const r = validatePlanningConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});

describe("per-tick spending counters (HUD diagnostics)", () => {
  it("report the expansions charged, the budget of the stepped queries and their number; zero when nothing is planned", () => {
    const grid = workloadGrid();
    const service = new PlanningService(grid, { cachesEnabled: false });
    service.tick(1);
    expect(service.lastTick).toEqual({ expansions: 0, budget: 0, queries: 0 });
    expect(service.submit(req("ugv-001", [1, 1], [60, 60]), 1).ok).toBe(true);
    expect(service.submit(req("ugv-002", [2, 60], [60, 2], cfg({ onboardComputeExpansionsPerTick: 100 })), 1).ok).toBe(true);
    service.tick(2);
    // Two queries stepped with 300 and 100 expansions of budget: each spends its whole slice while it is still searching.
    expect(service.lastTick).toEqual({ expansions: 400, budget: 400, queries: 2 });
    for (let t = 3; t < 400; t++) {
      service.tick(t);
      service.takeCompleted();
    }
    expect(service.lastTick.queries).toBe(0);
    expect(service.lastTick.expansions).toBe(0);
  });
});

describe("path smoothing", () => {
  it("keeps endpoints, removes redundant waypoints and never crosses obstacles or squeezes through corners", () => {
    const g = randomGrid(31, 48, 0.2, 16);
    const s = space(g);
    const q = new GridSearch(s, 1 * 48 + 1, 46 * 48 + 46, { kind: "astar" }, 1e9);
    q.runToCompletion();
    if (q.status !== "found") return;
    const cells = q.path();
    const wp = smoothPath(s, cells);
    expect(wp.length).toBeLessThan(cells.length);
    expect(wp[0]).toEqual([1.5, 1.5]);
    expect(wp.at(-1)).toEqual([46.5, 46.5]);
    for (let k = 1; k < wp.length; k++) {
      const [ax, ay] = wp[k - 1] ?? [0, 0];
      const [bx, by] = wp[k] ?? [0, 0];
      expect(clearSegment(s, ax, ay, bx, by)).toBe(true);
    }
  });

  it("refuses to pass diagonally between two obstacles touching at a corner", () => {
    const g = new GridSpace({ sizeX: 10, sizeY: 10, resolutionM: 1, chunkSize: 8 });
    g.setCell("occupancy", 5, 4, OCCUPANCY_BLOCKED);
    g.setCell("occupancy", 4, 5, OCCUPANCY_BLOCKED);
    const s = space(g);
    expect(clearSegment(s, 4.5, 4.5, 5.5, 5.5)).toBe(false);
    expect(clearSegment(s, 1.5, 1.5, 3.5, 3.5)).toBe(true);
  });

  it("property: on seeded random terrain-cost grids, smoothing never increases the path's cost under the same profile", () => {
    const profiles: CostProfile[] = [
      { weights: { distance: 1 } },
      { weights: { distance: 1, terrain: 1 } },
      { weights: { terrain: 1 } },
      { weights: { distance: 0.5, terrain: 2, time: 1 } },
      { weights: { distance: 1, terrain: 1, turn: 0.5 } },
      { weights: { terrain: 1, turn: 3 } },
    ];
    let checked = 0;
    let shortened = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = randomGrid(seed, 40, 0.12, 8);
      const rng = Rng.fromSeed(seed).derive("smoothing-property");
      for (const profile of profiles) {
        for (const traversal of [UGV, UAV]) {
          const s = space(g, traversal, profile);
          const free = (c: number) => s.passable(c % 40, (c / 40) | 0);
          let from = rng.intRange(0, 40 * 40 - 1);
          let to = rng.intRange(0, 40 * 40 - 1);
          while (!free(from)) from = (from + 1) % (40 * 40);
          while (!free(to)) to = (to + 7) % (40 * 40);
          const q = new GridSearch(s, from, to, { kind: "astar" }, 1e9);
          q.runToCompletion();
          if (q.status !== "found") continue;
          const cells = q.path();
          const raw = cells.map((c): [number, number] => [(c % 40) + 0.5, ((c / 40) | 0) + 0.5]);
          const smoothed = smoothPath(s, cells);
          const rawCost = polylineCost(s, raw);
          const smoothCost = polylineCost(s, smoothed);
          expect(smoothCost, `seed ${seed} ${JSON.stringify(profile)} ${traversal.vehicle}`).toBeLessThanOrEqual(rawCost * (1 + 1e-9));
          expect(smoothed[0]).toEqual(raw[0]);
          expect(smoothed.at(-1)).toEqual(raw.at(-1));
          checked++;
          if (smoothed.length < raw.length) shortened++;
        }
      }
    }
    // The property is not vacuous: most cases are smoothed.
    expect(checked).toBeGreaterThan(300);
    expect(shortened).toBeGreaterThan(checked * 0.8);
  });

  it("profiles with edge constraints are only merged where moves are collinear (no shortcut may break a per-move limit)", () => {
    const g = new GridSpace({ sizeX: 20, sizeY: 20, resolutionM: 1, chunkSize: 8 });
    const s = space(g, UGV, { weights: { distance: 1 }, constraints: ["turn <= 0.8"] });
    const q = new GridSearch(s, 2 * 20 + 2, 17 * 20 + 9, { kind: "astar" }, 1e9);
    q.runToCompletion();
    const wp = smoothPath(s, q.path());
    for (let k = 1; k < wp.length; k++) {
      const [ax, ay] = wp[k - 1] ?? [0, 0];
      const [bx, by] = wp[k] ?? [0, 0];
      const dx = Math.abs(bx - ax);
      const dy = Math.abs(by - ay);
      expect(dx === 0 || dy === 0 || dx === dy, JSON.stringify(wp)).toBe(true);
    }
  });

  // Regression (F1 e6): string pulling checked passability only, so the detour a terrain-weighted search
  // found around costly ground was straightened back through it, and the cost profile had no visible effect.
  it("does not shortcut a cost-aware detour back through costlier terrain", () => {
    const g = new GridSpace({ sizeX: 30, sizeY: 30, resolutionM: 1, chunkSize: 8 });
    for (let j = 0; j < 20; j++) for (let i = 10; i < 20; i++) g.setCell("terrainCost", i, j, 200);
    const crossesMarsh = (wp: [number, number][]): boolean => {
      for (let k = 1; k < wp.length; k++) {
        const [ax, ay] = wp[k - 1] ?? [0, 0];
        const [bx, by] = wp[k] ?? [0, 0];
        for (let t = 0; t <= 100; t++) {
          const x = ax + ((bx - ax) * t) / 100;
          const y = ay + ((by - ay) * t) / 100;
          if (x >= 10 && x < 20 && y < 20) return true;
        }
      }
      return false;
    };
    const plan = (s: ReturnType<typeof space>) => {
      const q = new GridSearch(s, 5 * 30 + 5, 5 * 30 + 25, { kind: "astar" }, 1e9);
      q.runToCompletion();
      expect(q.status).toBe("found");
      return smoothPath(s, q.path());
    };
    const distanceOnly = plan(space(g));
    const weighted = plan(space(g, UGV, { weights: { distance: 1, terrain: 1 } }));
    expect(distanceOnly).toEqual([[5.5, 5.5], [25.5, 5.5]]);
    expect(crossesMarsh(distanceOnly)).toBe(true);
    expect(crossesMarsh(weighted)).toBe(false);
    expect(weighted.length).toBeGreaterThan(2);
  });
});
