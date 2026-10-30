import { runLockstep, type ComputeOutcome, type DecisionRequest } from "@agentsim/core";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario, type LoadedScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import type { ScenarioDocument } from "../schema.ts";
import { buildReferenceRun } from "../testing/reference-run.ts";
import { assembleRun } from "./assemble.ts";

/**
 * The compute tools of a mind (F4 M2, T-113, ADR-0014 addition of 2026-10-29) on the belief-boundary fixture: 64 x 64 m at 0.5 m, a true wall at x in [30, 31) for y < 50 that the `believer` has never
 * observed and the `oracle` (ideal beliefs) knows. The tools answer from the agent's own planning view, with its planner's budget, and never read a ground-truth cell for a belief agent.
 */

function scenario(): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "compute",
    name: "Compute",
    defaultSeed: 1,
    world: { resolutionM: 0.5, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [{ id: "base", kind: "base", rect: { x0: 2, y0: 2, x1: 8, y1: 8 } }],
    agents: [
      { kind: "ugv", key: "believer", start: { xM: 10, yM: 10 }, base: { xM: 5, yM: 5 } },
      { kind: "ugv", key: "oracle", start: { xM: 10, yM: 12 } },
    ],
  };
}

function build(over: Partial<RunConfigDocument> = {}) {
  const loaded = loadScenario(scenario());
  if (!loaded.ok) throw new Error(loaded.error.message);
  const g = loaded.value.grid;
  for (let j = 0; j < 100; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, 1);
  const resolved = resolveRunConfig({ schemaVersion: 0, scenario: { id: "compute", version: 1 }, beliefs: { byAgent: { oracle: { init: "ideal" } } }, ...over }, { loaded: loaded.value, version: 1 });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const run = assembleRun(loaded.value, resolved.value, new TraceBuffer("run-000001", () => 0, 10_000), { dtS: 0.1 });
  return { run, loaded: loaded.value };
}

type Built = ReturnType<typeof build>;
const idOf = (b: Built, key: string): string => (b.run.agents.find((x) => x.key === key) ?? b.run.agents[0]!).id;

/** A request as the world would have built it, for the space part the tools read. */
const requestOf = (b: Built, agentId: string): DecisionRequest => ({ agentId, tick: 0, simTimeS: 0, space: b.run.mindView.view(agentId, 0).space }) as unknown as DecisionRequest;

const call = (b: Built, agentId: string, tool: string, params: unknown): ComputeOutcome => b.run.compute.call(agentId, tool, params, requestOf(b, agentId));
const ok = (o: ComputeOutcome) => {
  if (!o.ok) throw new Error(`${o.code}: ${o.message}`);
  return o;
};

function instrument(obj: object, on: () => boolean, hits: string[], label: string): void {
  const proto = Object.getPrototypeOf(obj) as object;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d) continue;
    if (typeof d.value === "function") {
      const f = d.value as (...args: unknown[]) => unknown;
      Object.defineProperty(obj, name, { configurable: true, value: function (this: unknown, ...args: unknown[]) { if (on()) hits.push(`${label}.${name}`); return f.apply(this, args); } });
    } else if (d.get) {
      const g = d.get;
      Object.defineProperty(obj, name, { configurable: true, get: function (this: unknown) { if (on()) hits.push(`${label}.${name}`); return g.call(this); } });
    }
  }
}

function watchTruth(loaded: LoadedScenario) {
  let on = false;
  const hits: string[] = [];
  instrument(loaded.grid, () => on, hits, "grid");
  for (const name of ["occupancy", "terrainCost", "heightDm"] as const) instrument(loaded.grid[name], () => on, hits, name);
  return {
    hits,
    during<T>(f: () => T): T {
      on = true;
      try {
        return f();
      } finally {
        on = false;
      }
    },
  };
}

const wall = { to: { xM: 50, yM: 10 } };

describe("planPath", () => {
  it("plans on the agent's own map: the believer goes straight through the wall it has never seen, with the figures of its drive and battery", () => {
    const b = build();
    const o = ok(call(b, idOf(b, "believer"), "planPath", wall));
    const r = o.result as { status: string; lengthM: number; etaS: number; energyPct: number; waypoints: { xM: number; yM: number }[] };
    expect(o.status).toBe("found");
    expect(r.status).toBe("found");
    expect(r.lengthM).toBeGreaterThan(39.5);
    expect(r.lengthM).toBeLessThan(42);
    // The UGV's speed and energy per metre from its resolved body: time = length / speed, energy = length x Wh per metre / capacity.
    const agent = b.run.agents.find((a) => a.key === "believer")!;
    expect(r.etaS).toBeCloseTo(r.lengthM / (agent.body as { maxSpeedMps: number }).maxSpeedMps, 1);
    expect(r.energyPct).toBeCloseTo(((r.lengthM * agent.body.energy.movingWhPerM) / agent.body.battery.capacityWh) * 100, 1);
    expect(r.waypoints.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...r.waypoints.map((w) => w.yM))).toBeLessThan(15);
  });

  it("agrees with the planner of the run: the same view and budget give the same route as a planning query", () => {
    const b = build();
    const id = idOf(b, "believer");
    const q = b.run.planner.submit(id, { from: { x: 10, y: 10 }, to: { x: 50, y: 10 } }, 0);
    if (!q.ok) throw new Error(q.error.message);
    let plan = undefined as ReturnType<typeof b.run.planner.take>;
    for (let t = 0; t < 1000 && !plan; t++) {
      b.run.planner.advance(t);
      plan = b.run.planner.take(id, q.value);
    }
    expect(plan?.status).toBe("found");
    let len = 0;
    const w = plan?.waypoints ?? [];
    for (let k = 1; k < w.length; k++) len += Math.hypot((w[k]?.[0] ?? 0) - (w[k - 1]?.[0] ?? 0), (w[k]?.[1] ?? 0) - (w[k - 1]?.[1] ?? 0));
    const r = ok(call(b, id, "planPath", wall)).result as { lengthM: number };
    expect(r.lengthM).toBeCloseTo(len, 1);
  });

  it("the oracle, which knows the wall, plans round it: a much longer route", () => {
    const b = build();
    const r = ok(call(b, idOf(b, "oracle"), "planPath", { to: { xM: 50, yM: 12 } })).result as { lengthM: number; waypoints: { yM: number }[] };
    expect(r.lengthM).toBeGreaterThan(80);
    expect(Math.max(...r.waypoints.map((w) => w.yM))).toBeGreaterThan(50);
  });

  it("answers not_found for a point that is not passable, budget_exceeded when the node budget runs out, and refuses a point outside the map or home without a base", () => {
    const b = build();
    const id = idOf(b, "oracle");
    expect(ok(call(b, id, "planPath", { to: { xM: 30.2, yM: 10 } })).status).toBe("not_found"); // inside the true wall, which the oracle knows
    expect(call(b, id, "planPath", { to: { xM: 500, yM: 10 } })).toMatchObject({ ok: false, code: "point_out_of_bounds" });
    expect(call(b, id, "planPath", { to: "home" })).toMatchObject({ ok: false, code: "no_home" });
    expect(ok(call(b, idOf(b, "believer"), "planPath", { to: "home" })).status).toBe("found");
    // The oracle's route round the wall needs thousands of expansions; with 100 its search runs out.
    const small = build({ planning: { byAgent: { oracle: { onboardComputeExpansionsPerTick: 100, totalBudget: 100 } } } });
    expect(ok(call(small, idOf(small, "oracle"), "planPath", { to: { xM: 50, yM: 12 } })).status).toBe("budget_exceeded");
  });

  it("refuses what is not a compute tool or not valid, with stable codes", () => {
    const b = build();
    const id = idOf(b, "believer");
    expect(call(b, id, "goTo", { xM: 1, yM: 1 })).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(call(b, id, "planPath", { to: { xM: 1 } })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(call(b, id, "planPath", { to: { xM: 1, yM: 1 }, extra: 1 })).toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("is deterministic: the same call twice gives the same answer", () => {
    const b = build();
    const id = idOf(b, "oracle");
    const a = JSON.stringify(call(b, id, "planPath", { to: { xM: 50, yM: 12 } }));
    expect(JSON.stringify(call(b, id, "planPath", { to: { xM: 50, yM: 12 } }))).toBe(a);
  });
});

describe("estimateCost", () => {
  it("adds the legs of a tour in order, each planned on the agent's own map, and is found only if every leg is", () => {
    const b = build();
    const id = idOf(b, "believer");
    const o = ok(call(b, id, "estimateCost", { route: [{ xM: 20, yM: 10 }, { xM: 20, yM: 20 }, "home"] }));
    const r = o.result as { status: string; lengthM: number; legs: { status: string; lengthM: number }[] };
    expect(r.legs).toHaveLength(3);
    expect(r.legs[0]?.lengthM).toBeGreaterThan(9);
    expect(r.legs[1]?.lengthM).toBeGreaterThan(9);
    expect(r.lengthM).toBeCloseTo(r.legs.reduce((s, l) => s + l.lengthM, 0), 1);
    expect(r.status).toBe("found");
    const o2 = ok(call(b, idOf(b, "oracle"), "estimateCost", { route: [{ xM: 30.2, yM: 10 }, { xM: 20, yM: 12 }] }));
    expect(o2.status).toBe("not_found");
  });

  it("takes at most 10 points", () => {
    const b = build();
    const route = Array.from({ length: 11 }, () => ({ xM: 12, yM: 12 }));
    expect(call(b, idOf(b, "believer"), "estimateCost", { route })).toMatchObject({ ok: false, code: "invalid_params" });
  });
});

describe("kShortestPaths", () => {
  it("returns the best route first and different ones after it, with how much of their length they share with the best", () => {
    const b = build();
    const o = ok(call(b, idOf(b, "believer"), "kShortestPaths", { to: { xM: 50, yM: 10 }, k: 3 }));
    const r = o.result as { paths: { lengthM: number; sharedPct: number }[] };
    expect(r.paths.length).toBeGreaterThanOrEqual(2);
    expect(r.paths.length).toBeLessThanOrEqual(3);
    expect(r.paths[0]?.sharedPct).toBe(0);
    for (let n = 1; n < r.paths.length; n++) {
      expect(r.paths[n]?.lengthM).toBeGreaterThanOrEqual((r.paths[0]?.lengthM ?? 0) - 0.01);
      expect(r.paths[n]?.sharedPct).toBeLessThan(100);
    }
  });

  it("does not touch the live view: the best route is the same before and after asking for alternatives", () => {
    const b = build();
    const id = idOf(b, "believer");
    const before = JSON.stringify(call(b, id, "planPath", wall));
    ok(call(b, id, "kShortestPaths", { to: { xM: 50, yM: 10 }, k: 3 }));
    expect(JSON.stringify(call(b, id, "planPath", wall))).toBe(before);
  });

  it("asks for 1 to 3 routes", () => {
    const b = build();
    expect(call(b, idOf(b, "believer"), "kShortestPaths", { to: { xM: 50, yM: 10 }, k: 4 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(call(b, idOf(b, "believer"), "kShortestPaths", { to: { xM: 50, yM: 10 }, k: 0 })).toMatchObject({ ok: false, code: "invalid_params" });
  });
});

describe("querySpace", () => {
  it("gives back the summary of the request, or one region with the frontiers in it, or refuses an unknown region", () => {
    const b = build();
    const id = idOf(b, "believer");
    const req = requestOf(b, id);
    const whole = ok(b.run.compute.call(id, "querySpace", {}, req)).result as { summary: typeof req.space };
    expect(whole.summary).toEqual(req.space);
    const first = req.space.regions[0];
    expect(first).toBeDefined();
    const one = ok(b.run.compute.call(id, "querySpace", { region: first?.id }, req)).result as { region: { id: string }; frontiers: { region: string }[] };
    expect(one.region.id).toBe(first?.id);
    expect(one.frontiers.every((f) => f.region === first?.id)).toBe(true);
    expect(b.run.compute.call(id, "querySpace", { region: "Rnope" }, req)).toMatchObject({ ok: false, code: "unknown_region" });
  });
});

describe("the boundary: a belief agent's compute tools never read the ground truth (ADR-0005, ADR-0014 addition of 2026-10-29)", () => {
  it("none of the four touches the ground-truth grid for a belief agent", () => {
    const b = build();
    const truth = watchTruth(b.loaded);
    const id = idOf(b, "believer");
    const req = requestOf(b, id);
    truth.during(() => {
      ok(b.run.compute.call(id, "planPath", wall, req));
      ok(b.run.compute.call(id, "estimateCost", { route: [{ xM: 20, yM: 10 }, "home"] }, req));
      ok(b.run.compute.call(id, "kShortestPaths", { to: { xM: 50, yM: 10 }, k: 3 }, req));
      ok(b.run.compute.call(id, "querySpace", {}, req));
    });
    expect(truth.hits).toEqual([]);
  });

  it("positive control: the same calls of an ideal agent do read it (so the instrumentation sees what it should)", () => {
    const b = build();
    const truth = watchTruth(b.loaded);
    const id = idOf(b, "oracle");
    const req = requestOf(b, id);
    truth.during(() => {
      ok(b.run.compute.call(id, "planPath", { to: { xM: 50, yM: 12 } }, req));
    });
    expect(truth.hits.length).toBeGreaterThan(0);
  });
});

describe("observational purity", () => {
  it("a run in which the tools are called at every tick has the same state hashes and trace as one in which they are not (they change nothing)", async () => {
    const once = async (ask: boolean) => {
      const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } } }, scripts: {} });
      const hashes: string[] = [];
      for (let t = 0; t < 120; t++) {
        await runLockstep(run.world, run.scheduler, 1);
        if (ask) {
          for (const a of run.agents) {
            const req = { agentId: a.id, tick: run.world.tick, simTimeS: run.world.simTimeS, space: run.mindView.view(a.id, run.world.simTimeS).space } as unknown as DecisionRequest;
            run.compute.call(a.id, "planPath", { to: { xM: 40, yM: 40 } }, req);
            run.compute.call(a.id, "kShortestPaths", { to: { xM: 30, yM: 20 }, k: 3 }, req);
            run.compute.call(a.id, "estimateCost", { route: [{ xM: 20, yM: 20 }, { xM: 40, yM: 30 }] }, req);
            run.compute.call(a.id, "querySpace", {}, req);
          }
        }
        hashes.push(run.world.stateHash);
      }
      return { hashes, trace: run.trace.all().map((r) => ({ ...r, wallTime: 0 })) };
    };
    const asked = await once(true);
    const quiet = await once(false);
    expect(asked.hashes).toEqual(quiet.hashes);
    expect(asked.trace).toEqual(quiet.trace);
  });
});
