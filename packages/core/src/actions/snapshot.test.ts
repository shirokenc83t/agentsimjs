import { describe, expect, it } from "vitest";
import { decodeValue, encodeValue } from "../snapshot/codec.ts";
import { defaultReflexes } from "../reflexes/builtin.ts";
import type { SimAgent } from "./agent.ts";
import type { PlanQuery } from "./ports.ts";
import { ActionRuntime, type BehaviorSnapshot, type ExploreSnapshot, type GoToSnapshot, type RuntimePorts, type RuntimeSnapshot } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakeContact, FakeFrontiers, FakePlanner, FakeProximity, FakeSpatial, makeUav, makeUgv } from "./testing/fakes.ts";

// F3a M1: the action runtime's snapshot and restore (ADR-0035 addition of 2026-10-17, item 8). Each case runs a
// runtime to tick N, takes its snapshot through the codec, and restores it into a fresh runtime over the same ports in
// the state of tick N (a twin run, since the fakes keep state too). Both continue; every tick the agent's state and the
// info of its action must be byte-identical, the trace must match, and the snapshots must be byte-identical at the end.

const DT = 0.1;
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });
type P = [number, number];

interface Rig {
  readonly ports: RuntimePorts;
  readonly rt: ActionRuntime;
  readonly agent: SimAgent;
  readonly planner: FakePlanner;
  readonly spatial: FakeSpatial;
  readonly trace: CollectingTrace;
}

interface RigOptions {
  readonly agent: SimAgent;
  readonly action: { readonly name: string; readonly params: Record<string, unknown> };
  readonly reflexes?: boolean;
  readonly frontiers?: boolean;
  readonly setup?: (r: { spatial: FakeSpatial; planner: FakePlanner; frontiers: FakeFrontiers | undefined }) => void;
}

/** A fresh runtime with its fakes and the action started at tick 0, as the same call always builds the same thing. */
function build(o: RigOptions): Rig {
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const trace = new CollectingTrace();
  const frontiers = o.frontiers ? new FakeFrontiers(o.agent) : undefined;
  const ports: RuntimePorts = {
    planner,
    spatial,
    capabilities: fakeCapabilities,
    trace,
    ...(o.reflexes ? { reflexes: defaultReflexes(), proximity: new FakeProximity(spatial, 2), contact: new FakeContact() } : {}),
    ...(frontiers ? { frontiers } : {}),
  };
  o.setup?.({ spatial, planner, frontiers });
  const rt = new ActionRuntime(ports, DT);
  const started = rt.start(o.agent, o.action.name, o.action.params, self(o.agent), 0, 0);
  if (!started.ok) throw new Error(`${o.action.name}: ${started.error.code}`);
  return { ports, rt, agent: o.agent, planner, spatial, trace };
}

/** One tick as the world runs it: the planning phase, the agent's action, then the ended actions are taken. */
const tick = (r: Rig, rt: ActionRuntime, t: number) => {
  r.planner.advance(t);
  rt.tick(r.agent, t, t * DT);
  rt.takeEnded();
};
const stateOf = (a: SimAgent) => encodeValue({ state: { ...a.state }, battery: { ...a.battery }, odometerM: a.odometerM });
const infoOf = (rt: ActionRuntime, a: SimAgent) => encodeValue({ info: rt.info(a.id) ?? null, running: rt.isRunning(a.id) });
const activeOf = (s: RuntimeSnapshot): BehaviorSnapshot | undefined => s.active[0]?.behavior;

interface Outcome {
  readonly snapshot: RuntimeSnapshot;
}

/**
 * Runs `make()` to tick `n`, restores its snapshot into a fresh runtime over a twin's ports, and continues both for `after`
 * ticks. `fresh` lets a case give the new runtime different reflexes (to show what a missing piece of state does).
 */
function checkContinuation(make: () => Rig, n: number, after: number, opts: { edit?: (s: RuntimeSnapshot) => RuntimeSnapshot } = {}): Outcome & { a: Rig; b: Rig; restored: ActionRuntime } {
  const a = make();
  for (let t = 0; t < n; t++) tick(a, a.rt, t);
  const taken = a.rt.snapshot();
  const decoded = decodeValue(encodeValue(taken)) as RuntimeSnapshot;
  const snapshot = opts.edit ? opts.edit(decoded) : decoded;
  const b = make();
  for (let t = 0; t < n; t++) tick(b, b.rt, t);
  const restored = new ActionRuntime({ ...b.ports, ...(b.ports.reflexes ? { reflexes: defaultReflexes() } : {}) }, DT);
  restored.restore(snapshot, [b.agent]);
  if (!opts.edit) expect(encodeValue(restored.snapshot()), "snapshot(restore(snapshot)) is byte-identical").toEqual(encodeValue(taken));
  const traceA = a.trace.records.length;
  const traceB = b.trace.records.length;
  for (let t = n; t < n + after; t++) {
    tick(a, a.rt, t);
    tick(b, restored, t);
    if (opts.edit) continue; // an edited snapshot is meant to differ: the case looks at how
    expect(stateOf(b.agent), `agent state at tick ${t}`).toEqual(stateOf(a.agent));
    expect(infoOf(restored, b.agent), `action info at tick ${t}`).toEqual(infoOf(a.rt, a.agent));
  }
  if (!opts.edit) {
    expect(JSON.stringify(b.trace.records.slice(traceB))).toBe(JSON.stringify(a.trace.records.slice(traceA)));
    expect(encodeValue(restored.snapshot())).toEqual(encodeValue(a.rt.snapshot()));
  }
  return { snapshot, a, b, restored };
}

/** The first tick at which `pred` holds for the runtime built by `make` (to find the moment a case is about). */
function firstTick(make: () => Rig, pred: (s: RuntimeSnapshot, r: Rig) => boolean, max = 5000): number {
  const r = make();
  for (let t = 0; t < max; t++) {
    tick(r, r.rt, t);
    if (pred(r.rt.snapshot(), r)) return t + 1;
  }
  throw new Error("the moment never came");
}

const goToOf = (s: RuntimeSnapshot): GoToSnapshot => {
  const b = activeOf(s);
  if (b?.kind !== "goTo") throw new Error(`goTo expected, ${b?.kind}`);
  return b;
};

describe("action runtime snapshot and restore: behaviours (F3a M1)", () => {
  it("hold: the ticks held so far and the duration", () => {
    const make = () => build({ agent: makeUgv(), action: { name: "hold", params: { durationS: 3 } } });
    const { snapshot, restored, b } = checkContinuation(make, 10, 30);
    expect(snapshot.active).toHaveLength(1);
    expect(activeOf(snapshot)).toEqual({ kind: "hold", phase: "holding", ticks: 30, held: 10 });
    expect(restored.info(b.agent.id)).toMatchObject({ status: "succeeded", result: { heldS: 3 } });
  });

  it("an open hold keeps Infinity as its duration", () => {
    const make = () => build({ agent: makeUgv(), action: { name: "hold", params: {} } });
    const { snapshot } = checkContinuation(make, 5, 12);
    expect(activeOf(snapshot)).toMatchObject({ kind: "hold", ticks: Number.POSITIVE_INFINITY, held: 5 });
  });

  it("takeoff: where the climb started and the altitude it rises to", () => {
    const make = () => build({ agent: makeUav(12, 7, 0, false), action: { name: "takeoff", params: { altitudeM: 30 } } });
    const { snapshot, b } = checkContinuation(make, 10, 200);
    expect(activeOf(snapshot)).toEqual({ kind: "takeoff", phase: "climbing", x: 12, y: 7, altitudeM: 30 });
    expect(b.agent.kind === "uav" && b.agent.state.z).toBe(30);
  });

  it("land: mid-descent, with nothing of its own but its phase", () => {
    const make = () => build({ agent: makeUav(12, 7, 20, true), action: { name: "land", params: {} } });
    const { snapshot, b } = checkContinuation(make, 20, 200);
    expect(activeOf(snapshot)).toEqual({ kind: "land", phase: "descending" });
    expect(b.agent.kind === "uav" && b.agent.state.airborne).toBe(false);
  });

  it("goTo while planning: the query in flight, taken from the planner after the restore", () => {
    const make = () => build({ agent: makeUgv(10, 10, 0), action: { name: "goTo", params: { xM: 40, yM: 10 } }, setup: ({ planner }) => (planner.delayTicks = 12) });
    const { snapshot, b } = checkContinuation(make, 4, 400);
    const g = goToOf(snapshot);
    expect(g).toMatchObject({ phase: "planning", hasPlanMap: false, follower: undefined });
    expect(typeof g.queryId).toBe("string");
    expect(40 - b.agent.state.x).toBeLessThanOrEqual(0.5);
  });

  it("goTo while following: the path follower, its progress and the plan's map", () => {
    const make = () =>
      build({
        agent: makeUgv(10, 10, 0),
        action: { name: "goTo", params: { xM: 55, yM: 35 } },
        reflexes: true,
      });
    const { snapshot, a } = checkContinuation(make, 60, 700);
    const g = goToOf(snapshot);
    expect(g).toMatchObject({ phase: "following", hasPlanMap: true, backingOff: false });
    expect(g.follower?.segments.length).toBeGreaterThan(0);
    expect(g.follower?.pursuit.segment).toBeGreaterThanOrEqual(0);
    expect(55 - a.agent.state.x).toBeLessThanOrEqual(0.5);
  });

  it("goTo backing off from the planning band: the follower keeps the tighter arrival tolerance it was built with", () => {
    const y = 30;
    const make = () =>
      build({
        agent: makeUgv(20, y - 0.6, 0, { drive: "differential", reverseAllowed: true, turningRadiusM: 0 }),
        action: { name: "goTo", params: { xM: 20, yM: y - 12 } },
        reflexes: true,
        setup: ({ spatial }) => spatial.add({ x0: 0, y0: y, x1: 40, y1: y + 1 }),
      });
    const n = firstTick(make, (s) => activeOf(s)?.kind === "goTo" && goToOf(s).backingOff) + 3;
    const { snapshot, a } = checkContinuation(make, n, 800);
    const g = goToOf(snapshot);
    expect(g.phase).toBe("backing-off");
    expect(g.follower?.arrivalToleranceM).toBe(0.05); // the back-off's, not the body's 0.5
    expect(a.agent.kind === "ugv" && a.agent.body.arrivalToleranceM).toBe(0.5);
    expect(g.recoveries).toBeGreaterThan(0);
  });

  it("goTo of a UAV: the waypoints left, the cruise altitude, and the plan's map for that altitude", () => {
    const make = () => build({ agent: makeUav(10, 10, 20, true), action: { name: "goTo", params: { xM: 70, yM: 60, altitudeM: 25 } } });
    const { snapshot, a } = checkContinuation(make, 30, 800);
    const g = goToOf(snapshot);
    expect(g).toMatchObject({ cruise: 25, hasPlanMap: true });
    expect(g.uavPath.length).toBeGreaterThan(0);
    expect(a.agent.kind === "uav" && a.agent.state.z).toBe(25);
  });

  it("a lazy goTo holding for the next leg: holdStartS, legsPending and the follower at the end of the last ready leg", () => {
    const legs =
      (n: number) =>
      (q: PlanQuery): P[][] =>
        Array.from({ length: n }, (_, k): P[] => [
          [q.from.x + ((q.to.x - q.from.x) * k) / n, q.from.y + ((q.to.y - q.from.y) * k) / n],
          [q.from.x + ((q.to.x - q.from.x) * (k + 1)) / n, q.from.y + ((q.to.y - q.from.y) * (k + 1)) / n],
        ]);
    const make = () =>
      build({ agent: makeUgv(10, 10, 0), action: { name: "goTo", params: { xM: 40, yM: 10 } }, setup: ({ planner }) => (planner.lazy = { legs: legs(3), ready: [3, 400, 405] }) });
    const n = firstTick(make, (s) => activeOf(s)?.kind === "goTo" && goToOf(s).holdStartS !== undefined);
    const { snapshot, a } = checkContinuation(make, n + 20, 600);
    const g = goToOf(snapshot);
    expect(g.legsPending).toBe(true);
    expect(typeof g.holdStartS).toBe("number");
    expect(g.follower?.pursuit.path.length).toBeGreaterThan(2);
    expect(40 - a.agent.state.x).toBeLessThanOrEqual(0.5); // it went on once the legs came
  });

  it("explore: the target, the inner goTo and the frontier groups skipped", () => {
    const make = () =>
      build({
        agent: makeUgv(10, 10),
        action: { name: "explore", params: {} },
        frontiers: true,
        setup: ({ frontiers }) => {
          frontiers?.add("f-far", "r-00-00", 40, 10);
          frontiers?.add("f-near", "r-00-00", 20, 10);
        },
      });
    const { snapshot, restored, b } = checkContinuation(make, 60, 3000);
    const e = activeOf(snapshot) as ExploreSnapshot;
    expect(e.kind).toBe("explore");
    expect(e.inner?.kind).toBe("goTo");
    expect(e.target).toBeDefined();
    expect(restored.info(b.agent.id)).toMatchObject({ status: "succeeded", result: { reason: "frontier_exhausted", groupsVisited: 2 } });
    // This one runs the explore to its end three times over (up to 3,000 ticks each: the uninterrupted run, the continued run, the restored one),
    // and took 5,049 ms on a shared CI runner against the default 5,000 ms: the check is the same, the time it may take is not 5 s.
  }, 30_000);

  it("explore with unreachable groups: the strikes against each frontier cell and the cells skipped", () => {
    const make = () =>
      build({
        agent: makeUgv(10, 10),
        action: { name: "explore", params: {} },
        frontiers: true,
        setup: ({ frontiers, planner }) => {
          planner.status = "not_found";
          if (frontiers) frontiers.marksStick = false;
          frontiers?.add("f-a", "r-00-00", 30, 10);
          frontiers?.add("f-b", "r-00-00", 50, 10);
        },
      });
    const n = firstTick(make, (s) => (activeOf(s) as ExploreSnapshot | undefined)?.strikes.some(([, k]) => k >= 1) ?? false) + 1;
    const { snapshot, restored, b } = checkContinuation(make, n, 400);
    const e = activeOf(snapshot) as ExploreSnapshot;
    expect(e.strikes.length).toBeGreaterThan(0);
    expect(e.strikes.map(([c]) => c)).toEqual([...e.strikes.map(([c]) => c)].sort((x, y) => x - y)); // ascending: the snapshot is canonical
    expect(restored.info(b.agent.id)?.status).toBe("succeeded");
  });
});

describe("action runtime snapshot and restore: the runtime's own state (F3a M1)", () => {
  /** A UGV below its critical battery level: the reflex acts on the first tick and latches. */
  const lowBattery = () => {
    const a = makeUgv();
    a.battery.soc = 0.14;
    return a;
  };
  const reflexRecords = (r: Rig) => r.trace.records.filter((x) => x.kind === "reflex");

  it("the battery reflex's latch is captured: a restored runtime does not act a second time", () => {
    const make = () => build({ agent: lowBattery(), action: { name: "hold", params: {} }, reflexes: true });
    const { snapshot, a, b } = checkContinuation(make, 3, 60);
    expect(snapshot.reflexes).toEqual({ battery: ["ugv-001"] });
    expect(reflexRecords(a)).toHaveLength(1);
    expect(reflexRecords(b)).toHaveLength(1);
  });

  it("without the latch the reflex acts again (so the latch is state that matters)", () => {
    const make = () => build({ agent: lowBattery(), action: { name: "hold", params: {} }, reflexes: true });
    // The recovery (return to base) runs about 60 ticks; once it ends the battery is still critical and nothing latches the reflex.
    const { b } = checkContinuation(make, 3, 250, { edit: (s) => ({ ...s, reflexes: { battery: [] } }) });
    expect(reflexRecords(b).length).toBeGreaterThan(1);
  });

  it("agents in a reflex recovery stay in it, so their minds are still not asked", () => {
    const make = () => build({ agent: lowBattery(), action: { name: "hold", params: {} }, reflexes: true });
    const { snapshot, restored, b } = checkContinuation(make, 3, 5);
    expect(snapshot.recovering).toEqual(["ugv-001"]);
    expect(restored.isRecovering(b.agent.id)).toBe(true);
  });

  it("refuses while ended actions wait for the world to take them, and works once it has", () => {
    const r = build({ agent: makeUgv(), action: { name: "hold", params: { durationS: 0.1 } } });
    r.planner.advance(0);
    r.rt.tick(r.agent, 0, 0); // not through `tick`: the world would take the ended action
    expect(r.rt.isRunning(r.agent.id)).toBe(false);
    expect(() => r.rt.snapshot()).toThrow(/ended actions not yet taken/);
    expect(r.rt.takeEnded()).toHaveLength(1);
    expect(r.rt.snapshot().active).toEqual([]);
    expect(r.rt.snapshot().last).toHaveLength(1);
  });

  it("the action counter and each agent's latest action come back, so the next action gets the next ID", () => {
    const a = build({ agent: makeUgv(), action: { name: "hold", params: { durationS: 0.2 } } });
    for (let t = 0; t < 5; t++) tick(a, a.rt, t);
    a.rt.takeEnded();
    const snap = decodeValue(encodeValue(a.rt.snapshot())) as RuntimeSnapshot;
    const fresh = new ActionRuntime(a.ports, DT);
    fresh.restore(snap, [a.agent]);
    expect(fresh.info(a.agent.id)).toEqual(a.rt.info(a.agent.id));
    const next = fresh.start(a.agent, "hold", {}, self(a.agent), 5, 0.5);
    expect(next).toEqual({ ok: true, value: "act-000002" });
  });

  it("refuses a snapshot of an agent the runtime does not know, and a reflex state it cannot read", () => {
    const a = build({ agent: makeUgv(), action: { name: "hold", params: {} }, reflexes: true });
    const snap = decodeValue(encodeValue(a.rt.snapshot())) as RuntimeSnapshot;
    const fresh = new ActionRuntime({ ...a.ports, reflexes: defaultReflexes() }, DT);
    expect(() => fresh.restore(snap, [makeUav()])).toThrow(/unknown agent ugv-001/);
    expect(() => fresh.restore({ ...snap, reflexes: { battery: "ugv-001" } }, [a.agent])).toThrow(/list of agent IDs/);
  });
});
