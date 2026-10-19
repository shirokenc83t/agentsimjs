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
    const targets = (env.trace.ops("explore-target") as { event: string; group: number; strategy: string; candidates: number }[]).filter((t) => t.event === "selected");
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

  it("a target that cannot be answered in its window is marked for the iteration, then tried from windows that grow, and marked for good at the third", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-behind", "r-00-00", 40, 10);
    env.planner.status = "not_found";
    env.planner.explore = { radiusM: 40, windowMarginM: 5 };
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsMarked: 1 });
    expect(env.frontiers.temporaryCalls).toEqual(["f-behind", "f-behind", "f-behind"]); // once in the iteration, then at the first two travels
    expect(env.frontiers.markCalls).toEqual(["f-behind"]); // the third travel marks for good
    const windows = env.planner.submissions.map((s) => s.q.window);
    // The iteration: the square of side 2 (R + margin) around its centre; then the travels: the box of agent and target plus a margin that grows fourfold.
    expect(windows).toEqual([
      { x0: -35, y0: -35, x1: 55, y1: 55 },
      { x0: 5, y0: 5, x1: 45, y1: 15 },
      { x0: -10, y0: -10, x1: 60, y1: 30 },
      { x0: -70, y0: -70, x1: 120, y1: 90 },
    ]);
  });

  it("a budget_exceeded inside the window is handled as not_found: marked for now, never skipped for the action", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-costly", "r-00-00", 40, 10);
    env.planner.status = "budget_exceeded";
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsMarked: 1 });
    expect(env.frontiers.temporaryCalls.length).toBeGreaterThanOrEqual(2);
    expect(env.frontiers.markCalls).toEqual(["f-costly"]);
  });

  it("works in iterations: the groups within the radius first, nearest first; then the next centre is the nearest group left, reached by a travel on the box of agent and target", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.planner.explore = { radiusM: 20, windowMarginM: 5 };
    env.frontiers.add("f-far", "r-00-00", 70, 10);
    env.frontiers.add("f-2", "r-00-00", 28, 10);
    env.frontiers.add("f-1", "r-00-00", 20, 10);
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsVisited: 3, groupsMarked: 0 });
    const targets = (env.trace.ops("explore-target") as { event: string; group: number; mode: string; iteration: number }[]).filter((t) => t.event === "selected");
    expect(targets.map((t) => [t.group, t.mode])).toEqual([
      [10 * 100 + 20, "iterate"],
      [10 * 100 + 28, "iterate"],
      [10 * 100 + 70, "travel"],
    ]);
    const its = env.trace.ops("explore-iteration") as { event: string; iteration: number; centre: number[]; radiusM: number; window: number[] }[];
    expect(its[0]).toMatchObject({ event: "start", iteration: 1, centre: [10, 10], radiusM: 20, window: [-15, -15, 35, 35] });
    expect(its.filter((i) => i.event === "end").length).toBe(its.filter((i) => i.event === "start").length);
    // The travel to f-far: the box of the agent (where it ended the iteration) and the target, plus the margin.
    const travel = env.planner.submissions.find((s) => Math.abs(s.q.to.x - 70) < 1);
    expect(travel?.q.window).toBeDefined();
    const w = travel?.q.window;
    expect(w && w.x0 <= travel.q.from.x - 5 + 1e-9 && w.x1 >= 70 + 5 - 1e-9).toBe(true);
  });

  it("explore takes a radiusM that overrides the configured one for the action", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.planner.explore = { radiusM: 5, windowMarginM: 5 };
    env.frontiers.add("f-1", "r-00-00", 30, 10);
    env.rt.start(a, "explore", { radiusM: 60 }, self(a), 0, 0);
    run(env, a);
    const it0 = (env.trace.ops("explore-iteration") as { event: string; radiusM: number; window: number[] }[])[0];
    expect(it0).toMatchObject({ event: "start", radiusM: 60, window: [-55, -55, 75, 75] });
    expect((env.trace.ops("explore-target") as { event: string; mode: string }[]).find((t) => t.event === "selected")?.mode).toBe("iterate");
  });

  it("a target that needs a detour outside the first window is reached by a later, wider attempt", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.planner.explore = { radiusM: 20, windowMarginM: 5 };
    env.frontiers.add("f-detour", "r-00-00", 40, 10);
    // The only way to it runs beyond x = 70: a window that ends before that cannot answer.
    env.planner.answer = (q) => (q.window && q.window.x1 < 70 ? "not_found" : "found");
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsVisited: 1, groupsMarked: 0 });
    expect(env.planner.submissions.length).toBeGreaterThanOrEqual(2);
    expect(env.planner.submissions.at(-1)?.q.window?.x1).toBeGreaterThanOrEqual(70);
    expect(env.frontiers.markCalls).toEqual([]);
  });

  it("a group that fails from three different centres is marked for good; exhausted only when nothing unmarked is left", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.planner.explore = { radiusM: 40, windowMarginM: 5 };
    env.frontiers.add("f-bad", "r-00-00", 40, 30); // off the line the agent drives along, so that it does not resolve it on the way
    env.frontiers.add("f-h1", "r-00-00", 65, 10);
    env.frontiers.add("f-h2", "r-00-00", 95, 10);
    env.planner.answer = (q) => (Math.abs(q.to.y - 30) < 1 ? "not_found" : "found");
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    const info = run(env, a);
    expect(env.frontiers.markCalls).toEqual(["f-bad"]);
    expect(env.frontiers.temporaryCalls.filter((g) => g === "f-bad").length).toBeGreaterThanOrEqual(2);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsVisited: 2, groupsMarked: 1 });
    // Temporary marks never outlive the action.
    expect(env.frontiers.temporary.size).toBe(0);
    const marks = env.trace.ops("explore-target").filter((t) => (t as { event: string }).event === "marked") as { mark: string; centres: number }[];
    expect(marks.at(-1)).toMatchObject({ mark: "permanent", centres: 3 });
  });

  it("a goal in the inflated band moves to the group's nearest passable cell inside the window; with none, the group is marked without a search", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-band", "r-00-00", 30, 10, 5); // cells 30..34 on row 10
    env.planner.viewBlocked = (x) => x < 32; // the planner's view blocks the first two cells
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    run(env, a);
    const first = env.planner.submissions[0]?.q;
    expect(first?.to).toEqual({ x: 32.5, y: 10.5 }); // the passable cell of the group nearest to its point
    expect(env.frontiers.markCalls).toEqual([]);

    const b = makeUgv(10, 10);
    const env2 = setup(b);
    env2.frontiers.add("f-walled", "r-00-00", 30, 10, 3);
    env2.planner.viewBlocked = (x, y) => x >= 29 && x < 34 && y >= 9 && y < 12;
    env2.rt.start(b, "explore", {}, self(b), 0, 0);
    const info = run(env2, b);
    expect(env2.planner.submissions).toHaveLength(0); // no search charged
    expect(env2.frontiers.markCalls).toEqual(["f-walled"]);
    expect(info?.result).toMatchObject({ reason: "frontier_exhausted", groupsMarked: 1 });
    expect((env2.trace.ops("explore-target") as { event: string; mark?: string; reason?: string }[]).find((t) => t.event === "marked")).toMatchObject({ mark: "permanent", reason: "blocked_in_view" });
  });

  it("the temporary marks are cleared when the action is replaced", () => {
    const a = makeUgv(10, 10);
    const env = setup(a);
    env.frontiers.add("f-behind", "r-00-00", 40, 10);
    env.planner.status = "not_found";
    env.rt.start(a, "explore", {}, self(a), 0, 0);
    let t = 0;
    for (; t < 400 && env.frontiers.temporary.size === 0; t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    expect(env.frontiers.temporary.size).toBeGreaterThan(0);
    env.rt.start(a, "hold", {}, self(a), t, t * DT);
    expect(env.frontiers.temporary.size).toBe(0);
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
