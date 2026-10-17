import { describe, expect, it } from "vitest";
import { StateHasher } from "../numerics/state-hash.ts";
import { hashAgent, type SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUav, makeUgv } from "./testing/fakes.ts";

const DT = 0.1;

/** By default the agent's map is the ground truth (F1); pass a separate `belief` to make them differ. */
function setup(spatial = new FakeSpatial(), belief: FakeSpatial = spatial) {
  const planner = new FakePlanner(belief);
  const trace = new CollectingTrace();
  const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace }, DT);
  return { planner, spatial, trace, rt };
}

const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

/** Runs the planning and action phases until the agent's action ends; returns the final info. */
function runUntilDone(env: ReturnType<typeof setup>, agent: SimAgent, from = 0, maxTicks = 5000) {
  let t = from;
  for (; t < from + maxTicks; t++) {
    env.planner.advance(t);
    env.rt.tick(agent, t, t * DT);
    if (!env.rt.isRunning(agent.id)) break;
  }
  return { info: env.rt.info(agent.id), lastTick: t };
}

describe("action start checks (stable codes, fixed order)", () => {
  it.each([
    ["unknown capability", "fly", {}, "unknown_capability"],
    ["invalid params", "goTo", { xM: "1" }, "invalid_params"],
    ["vehicle unsupported", "takeoff", { altitudeM: 10 }, "vehicle_unsupported"],
    ["ground vehicle with an altitude", "goTo", { xM: 20, yM: 10, altitudeM: 5 }, "invalid_params"],
    ["target outside the map", "goTo", { xM: 150, yM: 10 }, "target_out_of_bounds"],
  ])("%s → %s", (_, name, params, code) => {
    const env = setup();
    const a = makeUgv();
    const r = env.rt.start(a, name, params, self(a), 0, 0);
    expect(r.ok ? null : r.error.code).toBe(code);
    expect(env.trace.ops("rejected")).toHaveLength(1);
    expect(env.rt.isRunning(a.id)).toBe(false);
  });

  it("rejects callers other than the agent itself, an empty battery and unmet preconditions", () => {
    const env = setup();
    const a = makeUgv();
    expect(env.rt.start(a, "hold", {}, { scope: "self", id: "ugv-002" }, 0, 0)).toMatchObject({ ok: false, error: { code: "scope_denied" } });
    expect(env.rt.start(a, "hold", {}, { scope: "world", id: "researcher" }, 0, 0)).toMatchObject({ ok: false, error: { code: "scope_denied" } });
    const grounded = makeUav();
    expect(env.rt.start(grounded, "goTo", { xM: 20, yM: 20 }, self(grounded), 0, 0)).toMatchObject({ ok: false, error: { code: "precondition_failed" } });
    const { base: _base, ...rest } = makeUgv();
    const noBase: SimAgent = rest;
    expect(env.rt.start(noBase, "returnToBase", {}, self(noBase), 0, 0)).toMatchObject({ ok: false, error: { code: "precondition_failed" } });
    const empty = makeUgv();
    empty.battery.soc = 0;
    expect(env.rt.start(empty, "hold", {}, self(empty), 0, 0)).toMatchObject({ ok: false, error: { code: "battery_depleted" } });
  });

  it("rejects a blocked target", () => {
    const env = setup();
    env.spatial.add({ x0: 30, y0: 0, x1: 40, y1: 100 });
    const a = makeUgv();
    expect(env.rt.start(a, "goTo", { xM: 35, yM: 10 }, self(a), 0, 0)).toMatchObject({ ok: false, error: { code: "target_blocked" } });
  });
});

describe("goTo (UGV)", () => {
  it("plans (taking sim time), follows the path and succeeds within the arrival tolerance", () => {
    const env = setup();
    env.planner.delayTicks = 5;
    const a = makeUgv(10, 10, 0);
    expect(env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0).ok).toBe(true);
    const { info } = runUntilDone(env, a);
    expect(info?.status).toBe("succeeded");
    const r = info?.result as { position: { xM: number }; pathLengthM: number };
    expect(40 - r.position.xM).toBeLessThanOrEqual(0.5);
    expect(r.pathLengthM).toBeCloseTo(r.position.xM - 10, 6);
    const phases = env.trace.ops("phase") as { from: string; to: string }[];
    expect(phases.map((p) => `${p.from}>${p.to}`)).toEqual(["planning>following"]);
    expect(env.planner.submissions).toHaveLength(1);
  });

  it("fails unreachable or planning_budget when the planner says so", () => {
    for (const [status, code] of [["not_found", "unreachable"], ["budget_exceeded", "planning_budget"]] as const) {
      const env = setup();
      env.planner.status = status;
      const a = makeUgv();
      env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
      expect(runUntilDone(env, a).info?.failure?.code).toBe(code);
    }
  });

  it("turns around on its turning circle when there is room, and fails kinematically_infeasible when there is none", () => {
    // Facing east, target 20 m west: a forward-only vehicle must turn around.
    const open = setup();
    const a = makeUgv(50, 50, 0);
    open.rt.start(a, "goTo", { xM: 30, yM: 50 }, self(a), 0, 0);
    expect(runUntilDone(open, a).info?.status).toBe("succeeded");

    // A 2 m wide corridor (footprint 0.5 m, turning radius 1.5 m): no room for the turning circle.
    const narrow = setup();
    narrow.spatial.add({ x0: 0, y0: 0, x1: 100, y1: 49 });
    narrow.spatial.add({ x0: 0, y0: 51, x1: 100, y1: 100 });
    const b = makeUgv(50, 50, 0);
    narrow.rt.start(b, "goTo", { xM: 30, yM: 50 }, self(b), 0, 0);
    const r = runUntilDone(narrow, b);
    expect(r.info?.failure?.code).toBe("kinematically_infeasible");
    expect(b.state.x).toBe(50); // it never started driving into the walls
  });

  it("the pre-drive check follows the agent's map, never ground truth (ADR-0005)", () => {
    // Belief: a 2 m corridor (no room to turn around). Ground truth: open field.
    const narrowBelief = new FakeSpatial();
    narrowBelief.add({ x0: 0, y0: 0, x1: 100, y1: 49 });
    narrowBelief.add({ x0: 0, y0: 51, x1: 100, y1: 100 });
    const believesNarrow = setup(new FakeSpatial(), narrowBelief);
    const a = makeUgv(50, 50, 0);
    believesNarrow.rt.start(a, "goTo", { xM: 30, yM: 50 }, self(a), 0, 0);
    expect(runUntilDone(believesNarrow, a).info?.failure?.code).toBe("kinematically_infeasible");
    expect(believesNarrow.trace.ops("predrive")).toEqual([expect.objectContaining({ ok: false, reason: "contact" })]);

    // The reverse: ground truth narrow, belief open. The check passes (it cannot know), and contact is
    // handled at drive time by the body.
    const truth = new FakeSpatial();
    truth.add({ x0: 0, y0: 0, x1: 100, y1: 49 });
    truth.add({ x0: 0, y0: 51, x1: 100, y1: 100 });
    const believesOpen = setup(truth, new FakeSpatial());
    const b = makeUgv(50, 50, 0);
    believesOpen.rt.start(b, "goTo", { xM: 30, yM: 50 }, self(b), 0, 0);
    const r = runUntilDone(believesOpen, b);
    expect(believesOpen.trace.ops("predrive")).toEqual([expect.objectContaining({ ok: true })]);
    expect(r.info?.failure?.code).toBe("collision");
  });

  it("traces the pre-drive outcome with the predicted minimum clearance", () => {
    const env = setup();
    env.spatial.add({ x0: 0, y0: 11.2, x1: 100, y1: 100 }); // 1.2 m away (clearances are capped at footprint + 1 m)
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    expect(runUntilDone(env, a).info?.status).toBe("succeeded");
    const [p] = env.trace.ops("predrive") as { ok: boolean; predictedMinClearanceM: number }[];
    expect(p?.ok).toBe(true);
    expect(p?.predictedMinClearanceM).toBeCloseTo(1.2, 6);
  });

  it("fails kinematically_infeasible (not unreachable) when it makes no progress, e.g. a goal inside the turning circle", () => {
    const env = setup();
    const a = makeUgv(50, 50, 0);
    env.rt.start(a, "goTo", { xM: 50, yM: 50.9 }, self(a), 0, 0); // 0.9 m to the left, radius 1.5 m
    const { info } = runUntilDone(env, a);
    expect(info?.status).toBe("failed");
    expect(info?.failure?.code).toBe("kinematically_infeasible");
  });

  it("an obstacle the agent's map does not show: no replan, the body stops before it with collision", () => {
    const env = setup(new FakeSpatial(), new FakeSpatial());
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 }); // ground truth only
    const { info } = runUntilDone(env, a);
    expect(env.trace.ops("replan")).toEqual([]);
    expect(info?.failure?.code).toBe("collision");
    expect(env.spatial.groundClearanceM(a.state.x, a.state.y, 5)).toBeGreaterThanOrEqual(0.5);
  });

  it("an obstacle that appears on the agent's map under the remaining path: replan, then the new path is checked", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    for (let t = 0; t < 10; t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 }); // ground truth = the agent's map in F1
    const { info } = runUntilDone(env, a, 10);
    expect(env.trace.ops("replan")).toHaveLength(1);
    // The fake planner ignores obstacles: the new path crosses the wall, and the pre-drive check catches it.
    expect(info?.failure?.code).toBe("kinematically_infeasible");
    expect(a.state.x).toBeLessThan(25);
  });

  it("traces a diagnostic when the inward tracking error exceeds the margin", () => {
    const env = setup();
    // A left-hand corner hugging a block on its inside, with a tiny margin so the cut exceeds it.
    env.spatial.add({ x0: 0, y0: 10.6, x1: 28.8, y1: 100 });
    env.planner.route = (q) => [[q.from.x, q.from.y], [29.4, 10], [29.4, 30]];
    const a = makeUgv(10, 10, 0, { trackingMarginM: 0.01 });
    env.rt.start(a, "goTo", { xM: 29.4, yM: 30 }, self(a), 0, 0);
    runUntilDone(env, a);
    const d = env.trace.ops("diagnostic") as { code: string; peakInwardM: number; marginM: number }[];
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d[0]?.code).toBe("tracking_error_exceeds_margin");
    expect(d[0]?.peakInwardM).toBeGreaterThan(0.01);
    expect(env.trace.records.every((r) => r.source === "ugv-001/actions")).toBe(true);
  });

  it("is preempted by a new action", () => {
    const env = setup();
    const a = makeUgv();
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    env.planner.advance(0);
    env.rt.tick(a, 0, 0);
    env.rt.start(a, "hold", { durationS: 1 }, self(a), 1, 0.1);
    const ends = env.trace.ops("end") as { name: string; status: string }[];
    expect(ends).toEqual([expect.objectContaining({ name: "goTo", status: "preempted" })]);
    expect(runUntilDone(env, a, 1).info).toMatchObject({ name: "hold", status: "succeeded", result: { heldS: 1 } });
  });
});

describe("UAV actions", () => {
  it("takes off, flies at cruise altitude, and lands", () => {
    const env = setup();
    const a = makeUav(10, 10, 0, false);
    env.rt.start(a, "takeoff", { altitudeM: 20 }, self(a), 0, 0);
    expect(runUntilDone(env, a).info).toMatchObject({ status: "succeeded", result: { altitudeM: 20 } });
    expect(a.kind === "uav" && a.state.airborne).toBe(true);
    env.rt.start(a, "goTo", { xM: 60, yM: 30 }, self(a), 200, 20);
    const g = runUntilDone(env, a, 200);
    expect(g.info).toMatchObject({ status: "succeeded", result: { position: { xM: 60, yM: 30, zM: 20 } } });
    env.rt.start(a, "land", {}, self(a), 1000, 100);
    expect(runUntilDone(env, a, 1000).info?.status).toBe("succeeded");
    expect(a.kind === "uav" && !a.state.airborne && a.state.z === 0).toBe(true);
  });

  it("rejects altitudes outside the airspace and landing on an obstacle", () => {
    const env = setup();
    const grounded = makeUav();
    expect(env.rt.start(grounded, "takeoff", { altitudeM: 80 }, self(grounded), 0, 0)).toMatchObject({ ok: false, error: { code: "altitude_out_of_range" } });
    env.spatial.add({ x0: 0, y0: 0, x1: 20, y1: 20, topM: 5 });
    const flying = makeUav(10, 10, 20, true);
    expect(env.rt.start(flying, "land", {}, self(flying), 0, 0)).toMatchObject({ ok: false, error: { code: "landing_blocked" } });
  });

  it("returnToBase flies home at cruise altitude and lands", () => {
    const env = setup();
    const a = makeUav(50, 50, 10, true);
    env.rt.start(a, "returnToBase", {}, self(a), 0, 0);
    const { info } = runUntilDone(env, a);
    expect(info).toMatchObject({ status: "succeeded", result: { position: { xM: 5, yM: 5, zM: 0 }, landed: true } });
    expect(env.planner.submissions[0]?.q.cruiseAltitudeM).toBe(20);
  });
});

describe("battery and determinism", () => {
  it("drains while moving and fails the action when it runs out", () => {
    const env = setup();
    const a = makeUgv();
    a.battery.soc = 0.0005; // 0.25 Wh of 500 Wh: about 5 m of driving
    env.rt.start(a, "goTo", { xM: 80, yM: 10 }, self(a), 0, 0);
    const { info } = runUntilDone(env, a);
    expect(info?.failure?.code).toBe("battery_depleted");
    expect(a.battery.soc).toBe(0);
  });

  it("identical runs give identical traces and state hashes", () => {
    const run = () => {
      const env = setup();
      env.spatial.add({ x0: 30, y0: 0, x1: 100, y1: 9 });
      env.planner.route = (q) => [[q.from.x, q.from.y], [29, 11], [29, 30]];
      const a = makeUgv(10, 10, 0.3);
      env.rt.start(a, "goTo", { xM: 29, yM: 30 }, self(a), 0, 0);
      runUntilDone(env, a);
      const h = new StateHasher();
      hashAgent(h, a);
      return { hash: h.hex(), trace: JSON.stringify(env.trace.records) };
    };
    expect(run()).toEqual(run());
  });
});
