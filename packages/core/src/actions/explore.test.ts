import { describe, expect, it } from "vitest";
import type { SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakeFrontiers, FakePlanner, FakeSpatial, makeUgv } from "./testing/fakes.ts";

const DT = 0.1;

function setup(agent: SimAgent, belief = new FakeSpatial()) {
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(belief);
  const trace = new CollectingTrace();
  const frontiers = new FakeFrontiers(agent);
  const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, frontiers }, DT);
  return { planner, trace, frontiers, rt };
}

const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

function run(env: ReturnType<typeof setup>, agent: SimAgent, maxTicks = 20_000) {
  for (let t = 0; t < maxTicks; t++) {
    env.planner.advance(t);
    env.rt.tick(agent, t, t * DT);
    if (!env.rt.isRunning(agent.id)) break;
  }
  return env.rt.info(agent.id);
}

type Res = { reason: string; groupsVisited: number; groupsMarked: number; distanceM: number };

describe("explore (ADR-0039 addition of 2026-10-10)", () => {
  it("visits the nearest frontier first, then the next, and ends frontier_exhausted; every selection is traced", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-far", "r-00-00", 40, 10);
    env.frontiers.add("f-near", "r-00-00", 20, 10);
    expect(env.rt.start(a, "explore", {}, self(a), 0, 0).ok).toBe(true);
    const info = run(env, a);
    expect(info?.status).toBe("succeeded");
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsVisited: 2, groupsMarked: 0 });
    expect((info?.result as Res).distanceM).toBeGreaterThan(25);
    const targets = env.trace.ops("explore-target") as { group: number; strategy: string; candidates: number }[];
    expect(targets.map((t) => t.group)).toEqual([10 * 100 + 20, 10 * 100 + 40]);
    expect(targets[0]).toMatchObject({ strategy: "nearest", candidates: 2 });
  });

  it("largest picks the group with the most cells", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-small", "r-00-00", 20, 10, 3);
    env.frontiers.add("f-big", "r-00-00", 40, 10, 9);
    env.rt.start(a, "explore", { strategy: "largest" }, self(a), 0, 0);
    run(env, a);
    expect((env.trace.ops("explore-target")[0] as { group: number }).group).toBe(10 * 100 + 40);
  });

  it("unreachable answers mark the group; after 3 strikes it is skipped for the action, which then ends", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-behind", "r-00-00", 40, 10);
    env.frontiers.marksStick = false; // as if the view changed around it each time: only the strikes stop it
    env.planner.status = "not_found";
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsMarked: 3 });
    expect(env.frontiers.markCalls).toEqual(["f-behind", "f-behind", "f-behind"]);
    expect(env.planner.submissions).toHaveLength(3); // bounded: no livelock
  });

  it("a planning_budget failure marks nothing and skips the group for the rest of the action", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-costly", "r-00-00", 40, 10);
    env.planner.status = "budget_exceeded";
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsMarked: 0 });
    expect(env.frontiers.markCalls).toEqual([]);
    expect(env.planner.submissions).toHaveLength(1);
  });

  it("a kinematically_infeasible pre-drive answer marks the group (unreachable for this vehicle)", () => {
    const a = makeUgv(10, 10);
    const belief = new FakeSpatial();
    belief.add({ x0: 14, y0: 0, x1: 15, y1: 100 }); // a believed wall across the planned straight route
    const env = setup(a, belief);
    env.frontiers.add("f-across", "r-00-00", 40, 10);
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(env.frontiers.markCalls).toEqual(["f-across"]);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsMarked: 1 });
  });

  it("a region never seen is approached through the frontier nearest to it, then ends region_explored", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.regions.set("r-02-00", { x0: 64, y0: 0, x1: 96, y1: 32, reachableUnknown: true });
    env.frontiers.add("f-west", "r-00-00", 5, 10);
    env.frontiers.add("f-east", "r-01-00", 50, 10); // nearer to r-02-00's rectangle
    env.rt.start(a, "explore", { region: "r-02-00" }, self(a), 0, 0);
    const east = env.frontiers.groups.find((g) => g.id === "f-east");
    let t = 0;
    for (; t < 20_000 && !east?.resolved; t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    const first = env.trace.ops("explore-target")[0] as { group: number; approach?: string };
    expect(first).toMatchObject({ group: 10 * 100 + 50, approach: "r-02-00" });
    // Having approached, the region is seen: nothing reachable is left in it, and the west group is out of scope.
    env.frontiers.regions.set("r-02-00", { x0: 64, y0: 0, x1: 96, y1: 32, reachableUnknown: false });
    for (; t < 40_000 && env.rt.isRunning(a.id); t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    expect(env.rt.info(a.id)?.result).toMatchObject({ reason: "region_explored", groupsVisited: 1 });
    expect(env.trace.ops("explore-target")).toHaveLength(1); // the west group was never a target
  });

  it("after 2 s without map data at its own position, explore fails no_map_data: never frontier_exhausted", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.knowsOwnCell = false; // the sensors read nothing
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    let ticks = 0;
    for (; ticks < 100 && env.rt.isRunning(a.id); ticks++) {
      env.planner.advance(ticks);
      env.rt.tick(a, ticks, ticks * DT);
    }
    const info = env.rt.info(a.id);
    expect(info?.status).toBe("failed");
    expect(info?.failure?.code).toBe("no_map_data");
    expect(ticks).toBeGreaterThanOrEqual(20); // waited the 2 s first
    expect(ticks).toBeLessThanOrEqual(22);
    expect(env.planner.submissions).toHaveLength(0);
  });

  it("explore needs a range sensor: refused at start with precondition_failed (hasRangeSensor)", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.rangeSensor = false;
    expect(env.rt.start(a, "explore", {}, self(a), 0, 0)).toMatchObject({ ok: false, error: { code: "precondition_failed", message: expect.stringContaining("hasRangeSensor") } });
    expect(env.rt.isRunning(a.id)).toBe(false);
  });

  it("an unknown region is rejected at start with unknown_region", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    expect(env.rt.start(a, "explore", { region: "r-09-09" }, self(a), 0, 0)).toMatchObject({ ok: false, error: { code: "unknown_region" } });
  });

  it("a plain goTo to a frontier point that is unreachable marks its group", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-target", "r-00-00", 40, 10);
    env.planner.status = "not_found";
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    expect(run(env, a)?.failure?.code).toBe("unreachable");
    expect(env.frontiers.markCalls).toEqual(["f-target"]);
  });
});
