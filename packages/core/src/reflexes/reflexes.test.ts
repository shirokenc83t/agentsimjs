import { describe, expect, it } from "vitest";
import type { SimAgent } from "../actions/agent.ts";
import { ActionRuntime } from "../actions/runtime.ts";
import { CollectingTrace, fakeCapabilities, FakeContact, FakePlanner, FakeProximity, FakeSpatial, makeUav, makeUgv } from "../actions/testing/fakes.ts";
import { defaultReflexes } from "./builtin.ts";

const DT = 0.1;

function setup(spatial = new FakeSpatial(), belief: FakeSpatial = spatial, proximityRangeM = 2) {
  const planner = new FakePlanner(belief);
  const trace = new CollectingTrace();
  const proximity = new FakeProximity(spatial, proximityRangeM);
  const contact = new FakeContact();
  const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, reflexes: defaultReflexes(), proximity, contact }, DT);
  return { planner, spatial, belief, trace, rt, proximity, contact };
}

const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

function run(env: ReturnType<typeof setup>, a: SimAgent, from = 0, max = 5000) {
  env.proximity.track(a);
  let t = from;
  for (; t < from + max; t++) {
    env.planner.advance(t);
    env.rt.tick(a, t, t * DT);
    if (!env.rt.isRunning(a.id)) break;
  }
  return t;
}

const reflexRecords = (env: ReturnType<typeof setup>) => env.trace.records.filter((r) => r.kind === "reflex");
const actionEnds = (env: ReturnType<typeof setup>) => env.trace.ops("end") as { name: string; status: string; failure?: { code: string } }[];

describe("obstacle reflex: acts only on obstacles the plan did not account for", () => {
  it("stops before an obstacle missing from the agent's map, without contact", () => {
    const env = setup(new FakeSpatial(), new FakeSpatial());
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 }); // ground truth only
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)).toMatchObject({ status: "preempted", failure: { code: "obstacle_ahead" } });
    const [r] = reflexRecords(env);
    expect(r).toMatchObject({ source: "ugv-001/reflexes", kind: "reflex", payload: { reflex: "obstacle", code: "obstacle_ahead" } });
    expect(env.spatial.groundClearanceM(a.state.x, a.state.y, 5)).toBeGreaterThanOrEqual(a.body.footprintRadiusM);
    expect(actionEnds(env).some((e) => e.failure?.code === "collision")).toBe(false);
  });

  it("acts on the proximity sensor only: an obstacle beyond its range is not seen in time and the body collides", () => {
    // ADR-0012 addition of 2026-10-09: with a 0.3 m proximity range the obstacle is sensed too late to stop.
    const env = setup(new FakeSpatial(), new FakeSpatial(), 0.3);
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 });
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)?.failure?.code).toBe("collision");
    expect(reflexRecords(env)).toEqual([]);
  });

  it("with the proximity sensor dropped out, the body collides: the collision is traced, the action fails, contact is observed", () => {
    const env = setup(new FakeSpatial(), new FakeSpatial());
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 }); // an unknown wall
    const a = makeUgv(10, 10, 0);
    env.proximity.dropped.add(a.id);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)).toMatchObject({ status: "failed", failure: { code: "collision" } });
    const [c] = env.trace.records.filter((r) => r.kind === "event");
    expect(c).toMatchObject({ source: "ugv-001/body", kind: "event", payload: { op: "collision", cells: [25, 10], zM: 0 } });
    expect((c?.payload as { speedMps: number }).speedMps).toBeGreaterThan(0);
    expect(env.contact.contacts).toEqual([{ agentId: "ugv-001", cells: [25, 10], lowerM: 0 }]);
    // The body stopped at its last collision-free pose.
    expect(env.spatial.contactCells(a.state.x, a.state.y, 0, a.body.footprintRadiusM, "ugv")).toEqual([]);
    expect(reflexRecords(env)).toEqual([]);
  });

  it("never fires on obstacles the plan knows, even when the path passes close to them", () => {
    const env = setup();
    env.spatial.add({ x0: 0, y0: 10.6, x1: 100, y1: 100 }); // 0.6 m from the path, on the agent's map too
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)?.status).toBe("succeeded");
    expect(reflexRecords(env)).toEqual([]);
  });

  it("reflex and planner don't fight: once the map shows the obstacle, a new goTo goes around without the reflex firing again", () => {
    // A block appears ahead while the vehicle is driving, on ground truth and on the agent's map (in F1 the
    // agent knows the ground truth; from F2 its sensors put it on the belief map). goTo replans around it,
    // the new path passes the pre-drive check, and the reflex never fires: nothing is unaccounted for.
    const env = setup(new FakeSpatial(), new FakeSpatial());
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 60, yM: 10 }, self(a), 0, 0);
    for (let t = 0; t < 30; t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    const block = { x0: 40, y0: 6, x1: 42, y1: 14 };
    env.spatial.add(block);
    env.belief.add(block);
    env.planner.route = (q) => [[q.from.x, q.from.y], [34, 18], [48, 18], [q.to.x, q.to.y]];
    run(env, a, 30);
    expect(env.trace.ops("replan")).toHaveLength(1);
    expect(env.rt.info(a.id)?.status).toBe("succeeded");
    expect(reflexRecords(env)).toEqual([]);
  });
});

describe("recovery after a reflex stop (ADR-0033)", () => {
  // The d6 case: a block the agent did not know stops it ~1 m short; the map then learns the block and a
  // new goTo bends around it. Forward-only cannot turn away that close; differential rotates in place;
  // Ackermann backs off (bounded straight reverse) until the path passes the pre-drive check, then replans.
  it.each([
    ["differential", "succeeded"],
    ["ackermann", "succeeded"],
    ["forward-only", "kinematically_infeasible"],
  ] as const)("%s → %s", (drive, expected) => {
    const block = { x0: 25, y0: 9.2, x1: 26, y1: 9.8 };
    const env = setup(new FakeSpatial(), new FakeSpatial());
    env.spatial.add(block);
    const a = makeUgv(10, 10, 0, {
      drive,
      reverseAllowed: drive !== "forward-only",
      turningRadiusM: drive === "differential" ? 0 : drive === "ackermann" ? 1 / Math.tan(0.6) : 1.5,
    });
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    const t = run(env, a) + 1;
    expect(env.rt.info(a.id)?.failure?.code).toBe("obstacle_ahead");
    const stopped = { x: a.state.x, y: a.state.y };
    expect(25 - 0.5 - stopped.x).toBeLessThan(1.1); // stopped about 1 m short of the block
    env.belief.add(block);
    env.planner.route = (q) => [[q.from.x, q.from.y], [28, 12], [q.to.x, q.to.y]];
    env.rt.start(a, "goTo", { xM: 40, yM: 12 }, self(a), t, t * DT);
    run(env, a, t);
    const info = env.rt.info(a.id);
    expect(info?.status === "succeeded" ? "succeeded" : info?.failure?.code).toBe(expected);
    if (drive === "ackermann") expect(env.trace.ops("recovery").length).toBeGreaterThanOrEqual(1);
    expect(reflexRecords(env)).toHaveLength(1); // no second reflex: nothing unaccounted for after the map update
    expect(env.spatial.groundClearanceM(a.state.x, a.state.y, 5)).toBeGreaterThanOrEqual(0.5);
  });
});

describe("recovery order inside the planning clearance (ADR-0041, amending ADR-0033 §4)", () => {
  // Stopped 0.6 m from a block in front (inside the 0.75 m planning clearance), with another obstacle behind. Every recovery is checked on the
  // agent's map with the bare footprint before it is driven. Order: forward escape, then straight reverse, then stay.
  function wedged(rearBlockEndX: number, body: { drive: "differential" | "ackermann"; turningRadiusM: number } = { drive: "differential", turningRadiusM: 0 }) {
    const env = setup();
    env.spatial.add({ x0: 11.1, y0: 9, x1: 12, y1: 11 }); // block in front: 0.6 m of clearance
    env.spatial.add({ x0: rearBlockEndX - 1, y0: 9, x1: rearBlockEndX, y1: 11 }); // block behind
    const a = makeUgv(10.5, 10, 0, { ...body, reverseAllowed: true });
    env.rt.start(a, "goTo", { xM: 10.5, yM: 30 }, self(a), 0, 0); // open ground to the north
    let minClear = Number.POSITIVE_INFINITY;
    const poses: { x: number; y: number; h: number }[] = [];
    for (let t = 0; t < 2000 && env.rt.isRunning(a.id); t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
      minClear = Math.min(minClear, env.spatial.groundClearanceM(a.state.x, a.state.y, 5));
      poses.push({ x: a.state.x, y: a.state.y, h: a.state.heading });
    }
    return { env, a, minClear, poses };
  }

  it("with room behind and a way out forward: the escape is taken, not the reverse", () => {
    const { env, a, minClear } = wedged(8.5);
    const recs = env.trace.ops("recovery") as { kind: string; ok?: boolean }[];
    expect(recs[0]?.kind).toBe("escape");
    expect(recs[0]?.ok).toBeUndefined();
    expect(recs.some((r) => r.kind === "back-off")).toBe(false);
    expect(minClear).toBeGreaterThanOrEqual(a.body.footprintRadiusM);
    expect(env.rt.info(a.id)?.status).toBe("succeeded");
  });

  it("a differential vehicle rotates in place towards the escape before it translates", () => {
    const { env, a, poses } = wedged(8.5);
    const escapeTick = poses.findIndex((p) => Math.abs(p.h) > 1e-9 || Math.abs(p.x - 10.5) > 1e-9 || Math.abs(p.y - 10) > 1e-9);
    expect(escapeTick).toBeGreaterThanOrEqual(0);
    const turned = poses.findIndex((p) => Math.abs(p.h) > 1e-6);
    const moved = poses.findIndex((p) => Math.abs(p.x - 10.5) > 1e-6 || Math.abs(p.y - 10) > 1e-6);
    expect(turned).toBeGreaterThanOrEqual(0);
    expect(turned).toBeLessThanOrEqual(moved === -1 ? Number.POSITIVE_INFINITY : moved);
    expect(env.rt.info(a.id)?.status).toBe("succeeded");
  });

  it("an Ackermann vehicle in a dead-end corridor, which cannot turn round, has no escape and takes the straight reverse", () => {
    const env = setup();
    // A corridor 1.3 m wide along x (clearance 0.65 m inside the 0.75 m band), closed at x = 14, open behind from x = 10.5.
    env.spatial.add({ x0: 10.5, y0: 11.15, x1: 14, y1: 12.15 });
    env.spatial.add({ x0: 10.5, y0: 8.85, x1: 14, y1: 9.85 });
    env.spatial.add({ x0: 14, y0: 8.85, x1: 15, y1: 12.15 });
    const a = makeUgv(13, 10.5, 0, { drive: "ackermann", turningRadiusM: 1 / Math.tan(0.6), reverseAllowed: true });
    env.rt.start(a, "goTo", { xM: 3, yM: 10.5 }, self(a), 0, 0);
    let minClear = Number.POSITIVE_INFINITY;
    for (let t = 0; t < 3000 && env.rt.isRunning(a.id); t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
      minClear = Math.min(minClear, env.spatial.groundClearanceM(a.state.x, a.state.y, 5));
    }
    const recs = env.trace.ops("recovery") as { kind: string; ok?: boolean; distanceM?: number }[];
    expect(recs[0]).toMatchObject({ kind: "escape", ok: false });
    expect(recs[1]?.kind).toBe("back-off");
    expect(recs[1]?.ok).toBeUndefined();
    expect(recs[1]?.distanceM).toBeLessThanOrEqual(3);
    expect(minClear).toBeGreaterThanOrEqual(a.body.footprintRadiusM);
  });

  it("with no room behind either: neither an escape nor a reverse is drivable in this 0.1 m-margin corridor: it fails kinematically_infeasible without translating and without contact", () => {
    const { env, a, minClear } = wedged(9.9); // 0.6 m behind too: any reverse would touch, and the way sideways is a corridor too tight to drive
    expect(env.rt.info(a.id)?.failure?.code).toBe("kinematically_infeasible");
    expect(env.trace.ops("recovery")).toEqual([expect.objectContaining({ kind: "escape", ok: false }), expect.objectContaining({ kind: "back-off", ok: false })]);
    expect([a.state.x, a.state.y]).toEqual([10.5, 10]);
    expect(minClear).toBeGreaterThanOrEqual(a.body.footprintRadiusM);
  });

  it("truly boxed in (blocks on all four sides): stays where it is, fails kinematically_infeasible, and without translating or contact", () => {
    const env = setup();
    env.spatial.add({ x0: 11.1, y0: 9, x1: 12, y1: 11 });
    env.spatial.add({ x0: 8.9, y0: 9, x1: 9.9, y1: 11 });
    env.spatial.add({ x0: 9, y0: 10.6, x1: 12, y1: 11.6 });
    env.spatial.add({ x0: 9, y0: 8.4, x1: 12, y1: 9.4 });
    const a = makeUgv(10.5, 10, 0, { drive: "differential", reverseAllowed: true, turningRadiusM: 0 });
    env.rt.start(a, "goTo", { xM: 10.5, yM: 30 }, self(a), 0, 0);
    for (let t = 0; t < 200 && env.rt.isRunning(a.id); t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    expect(env.rt.info(a.id)?.failure?.code).toBe("kinematically_infeasible");
    expect(env.trace.ops("recovery")).toEqual([expect.objectContaining({ kind: "escape", ok: false }), expect.objectContaining({ kind: "back-off", ok: false })]);
    expect([a.state.x, a.state.y]).toEqual([10.5, 10]);
  });

  it("a forward-only vehicle keeps no recovery at all", () => {
    const env = setup();
    env.spatial.add({ x0: 11.1, y0: 9, x1: 12, y1: 11 });
    const a = makeUgv(10.5, 10, 0, { drive: "forward-only", reverseAllowed: false });
    env.rt.start(a, "goTo", { xM: 10.5, yM: 30 }, self(a), 0, 0);
    for (let t = 0; t < 300 && env.rt.isRunning(a.id); t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    expect(env.trace.ops("recovery")).toEqual([]);
  });
});

describe("geofence reflex", () => {
  it("vetoes a move that would leave the geofence", () => {
    const env = setup();
    env.spatial.fence = { x0: 0, y0: 0, x1: 100, y1: 30 };
    env.planner.route = (q) => [[q.from.x, q.from.y], [30, 40], [q.to.x, q.to.y]]; // detours outside the fence
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 50, yM: 10 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)).toMatchObject({ status: "preempted", failure: { code: "geofence" } });
    expect(env.spatial.insideFence(a.state.x, a.state.y, 0)).toBe(true);
  });

  it("keeps a UAV out of a no-fly volume", () => {
    const env = setup();
    env.spatial.noFly.push({ x0: 30, y0: 0, x1: 40, y1: 100, minZ: 0, maxZ: 60 });
    const a = makeUav(10, 10, 20, true);
    env.rt.start(a, "goTo", { xM: 60, yM: 10 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)).toMatchObject({ status: "preempted", failure: { code: "geofence" } });
    expect(a.state.x).toBeLessThan(30);
  });
});

describe("critical battery reflex (F1 acceptance)", () => {
  it("interrupts a goTo (preempted) and returns the UGV to base", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    a.battery.soc = 0.1504; // critical at 0.15: about 4 m of driving left above it
    env.rt.start(a, "goTo", { xM: 80, yM: 10 }, self(a), 0, 0);
    run(env, a);
    const ends = actionEnds(env);
    expect(ends[0]).toMatchObject({ name: "goTo", status: "preempted", failure: { code: "battery_critical" } });
    expect(env.rt.info(a.id)).toMatchObject({ name: "returnToBase", status: "succeeded" });
    expect(Math.hypot(a.state.x - 5, a.state.y - 5)).toBeLessThanOrEqual(a.kind === "ugv" ? a.body.arrivalToleranceM : 0);
    expect(reflexRecords(env).map((r) => (r.payload as { code: string; then?: string }).then)).toEqual(["returnToBase"]);
  });

  it("returns a UAV to base, where it lands", () => {
    const env = setup();
    const a = makeUav(40, 40, 20, true);
    a.battery.soc = 0.2004;
    env.rt.start(a, "goTo", { xM: 90, yM: 90 }, self(a), 0, 0);
    run(env, a);
    expect(env.rt.info(a.id)).toMatchObject({ name: "returnToBase", status: "succeeded", result: { landed: true } });
  });

  it("without a base: a UGV holds and a UAV lands where it is; it acts once", () => {
    const env = setup();
    const { base: _b, ...ugvNoBase } = makeUgv(10, 10, 0);
    const u: SimAgent = ugvNoBase;
    u.battery.soc = 0.1501;
    env.rt.start(u, "goTo", { xM: 80, yM: 10 }, self(u), 0, 0);
    for (let t = 0; t < 200; t++) {
      env.planner.advance(t);
      env.rt.tick(u, t, t * DT);
    }
    expect(env.rt.info(u.id)).toMatchObject({ name: "hold", status: "running" });
    expect(reflexRecords(env)).toHaveLength(1);

    const env2 = setup();
    const { base: _b2, ...uavNoBase } = makeUav(40, 40, 20, true);
    const v: SimAgent = uavNoBase;
    v.battery.soc = 0.2001;
    env2.rt.start(v, "goTo", { xM: 90, yM: 90 }, self(v), 0, 0);
    run(env2, v);
    expect(env2.rt.info(v.id)).toMatchObject({ name: "land", status: "succeeded" });
  });
});
