import { describe, expect, it } from "vitest";
import type { SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUav } from "./testing/fakes.ts";

// A UAV plans on its own map (ADR-0005). When the map changes under the path it is flying, it replans from where it is, as a ground vehicle does
// (ADR-0024): a wall that the lidar showed only after the plan was made must not be flown into.

const DT = 0.1;
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

function setup() {
  const truth = new FakeSpatial();
  const belief = new FakeSpatial();
  const planner = new FakePlanner(belief);
  const trace = new CollectingTrace();
  const rt = new ActionRuntime({ planner, spatial: truth, capabilities: fakeCapabilities, trace }, DT);
  return { truth, belief, planner, trace, rt };
}

describe("a UAV whose map changes under its path (ADR-0024)", () => {
  it("replans around a wall that its map learns while it flies towards it, and arrives without touching it", () => {
    const e = setup();
    const wall = { x0: 30, y0: 0, x1: 31, y1: 80, topM: Number.POSITIVE_INFINITY };
    e.truth.add(wall); // the wall is real from the start; the agent's map does not show it yet
    const a = makeUav(10, 10, 20, true);
    e.rt.start(a, "goTo", { xM: 60, yM: 10 }, self(a), 0, 0);
    let learnedAt = -1;
    let minClear = Number.POSITIVE_INFINITY;
    for (let t = 0; t < 2000 && e.rt.isRunning(a.id); t++) {
      e.planner.advance(t);
      e.rt.tick(a, t, t * DT);
      minClear = Math.min(minClear, e.truth.groundClearanceM(a.state.x, a.state.y, 5));
      if (learnedAt < 0 && a.state.x > 20) {
        // The lidar shows the wall: the map learns it, and a path that goes around it exists.
        learnedAt = t;
        e.belief.add(wall);
        e.planner.route = (q) => [[q.from.x, q.from.y], [29, 85], [32, 85], [q.to.x, q.to.y]];
      }
    }
    expect(learnedAt).toBeGreaterThan(0);
    expect(e.trace.ops("replan")).toEqual([expect.objectContaining({ reason: "map_changed" })]);
    expect(e.rt.info(a.id)?.status).toBe("succeeded");
    expect(minClear).toBeGreaterThanOrEqual(a.body.footprintRadiusM);
    expect(e.planner.submissions.length).toBe(2);
  });

  it("does not replan when the change leaves its path clear", () => {
    const e = setup();
    const a = makeUav(10, 10, 20, true);
    e.rt.start(a, "goTo", { xM: 60, yM: 10 }, self(a), 0, 0);
    let added = false;
    for (let t = 0; t < 2000 && e.rt.isRunning(a.id); t++) {
      e.planner.advance(t);
      e.rt.tick(a, t, t * DT);
      if (!added && a.state.x > 20) {
        added = true;
        e.belief.add({ x0: 30, y0: 60, x1: 31, y1: 80, topM: Number.POSITIVE_INFINITY }); // far from the straight path along y = 10
      }
    }
    expect(added).toBe(true);
    expect(e.trace.ops("replan")).toEqual([]);
    expect(e.rt.info(a.id)?.status).toBe("succeeded");
    expect(e.planner.submissions.length).toBe(1);
  });
});
