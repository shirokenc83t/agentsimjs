import { describe, expect, it } from "vitest";
import { defaultReflexes } from "../reflexes/builtin.ts";
import type { SimAgent } from "./agent.ts";
import type { PlanQuery } from "./ports.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakeContact, FakeFrontiers, FakePlanner, FakeProximity, FakeSpatial, makeUav, makeUgv } from "./testing/fakes.ts";

// ADR-0037 fourth addition (F2b M3): goTo with a lazy refine plan. The vehicle starts at the first leg, plans the others while
// it moves, holds at the end of the last ready leg, checks each leg before driving it, and replans from where it is.

const DT = 0.1;
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });
type P = [number, number];

function env(belief = new FakeSpatial(), withReflexes = false, spatial = new FakeSpatial()) {
  const planner = new FakePlanner(belief);
  const trace = new CollectingTrace();
  const prox = new FakeProximity(spatial, 2);
  const frontiers = (agent: SimAgent) => new FakeFrontiers(agent);
  const rt = (a: SimAgent, fr?: FakeFrontiers) =>
    new ActionRuntime(
      { planner, spatial, capabilities: fakeCapabilities, trace, ...(withReflexes ? { reflexes: defaultReflexes(), proximity: prox, contact: new FakeContact() } : {}), ...(fr ? { frontiers: fr } : {}) },
      DT,
    );
  return { planner, trace, spatial, belief, rt, frontiers, prox };
}

/** The legs of a straight route from the query's start to its goal, split into `n` equal legs. */
const straight =
  (n: number) =>
  (q: PlanQuery): P[][] =>
    Array.from({ length: n }, (_, k): P[] => {
      const a: P = [q.from.x + ((q.to.x - q.from.x) * k) / n, q.from.y + ((q.to.y - q.from.y) * k) / n];
      const b: P = [q.from.x + ((q.to.x - q.from.x) * (k + 1)) / n, q.from.y + ((q.to.y - q.from.y) * (k + 1)) / n];
      return [a, b];
    });

const ugvOf = (a: SimAgent) => {
  if (a.kind !== "ugv") throw new Error("a ground vehicle was expected");
  return a;
};

function run(e: ReturnType<typeof env>, rt: ActionRuntime, a: SimAgent, opts: { maxTicks?: number; each?: (t: number) => void; from?: number } = {}) {
  let t = opts.from ?? 0;
  const end = t + (opts.maxTicks ?? 6000);
  for (; t < end; t++) {
    e.planner.advance(t);
    rt.tick(a, t, t * DT);
    opts.each?.(t);
    if (!rt.isRunning(a.id)) break;
  }
  return { info: rt.info(a.id), lastTick: t };
}

describe("goTo with a lazy plan: moving while planning", () => {
  it("starts moving at the first leg, before the later legs are planned, and arrives sooner than with the same plan eager", () => {
    const firstMove = (lazy: boolean) => {
      const e = env();
      if (lazy) e.planner.lazy = { legs: straight(3), ready: [3, 8, 14] };
      else e.planner.delayTicks = 14; // the same legs, but nothing is known until all of them are
      const a = makeUgv(10, 10, 0);
      const rt = e.rt(a);
      rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
      let moved = -1;
      const r = run(e, rt, a, { each: (t) => void (moved < 0 && a.state.x > 10.2 && (moved = t)) });
      return { moved, done: r.lastTick, status: r.info?.status, x: a.state.x };
    };
    const lazy = firstMove(true);
    const eager = firstMove(false);
    expect(lazy.status).toBe("succeeded");
    expect(eager.status).toBe("succeeded");
    expect(lazy.moved).toBeGreaterThan(0);
    expect(lazy.moved).toBeLessThan(eager.moved);
    expect(lazy.done).toBeLessThan(eager.done);
    expect(40 - lazy.x).toBeLessThanOrEqual(0.5);
  });

  it("keeps the phase strings (planning, then following) and traces one note per leg with the predrive of each", () => {
    const e = env();
    e.planner.lazy = { legs: straight(3), ready: [3, 8, 14] };
    const a = makeUgv(10, 10, 0);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(e, rt, a);
    const phases = (e.trace.ops("phase") as { from: string; to: string }[]).map((p) => `${p.from}>${p.to}`);
    expect(phases).toEqual(["planning>following"]);
    expect((e.trace.ops("leg") as { index: number; count: number; last: boolean }[]).map((l) => [l.index, l.count, l.last])).toEqual([[0, 3, false], [1, 3, false], [2, 3, true]]);
    // Every leg names its query, so the Inspector's query table can attach legs to the right row (F2b M4).
    const legIds = (e.trace.ops("leg") as { queryId?: string }[]).map((l) => l.queryId);
    expect(legIds.every((q) => typeof q === "string" && q === legIds[0])).toBe(true);
    expect((e.trace.ops("predrive") as { leg?: number; ok: boolean }[]).map((p) => [p.leg, p.ok])).toEqual([[0, true], [1, true], [2, true]]);
    expect(e.planner.submissions).toHaveLength(1);
  });

  it("holds at the end of the last ready leg while the next is late: no overshoot, no success, no time-out, then goes on", () => {
    const e = env();
    e.planner.lazy = { legs: straight(3), ready: [3, 400, 405] };
    const a = makeUgv(10, 10, 0);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    let maxX = 0;
    let at399: { x: number; speed: number; status: string | undefined; phase: string | undefined } | undefined;
    run(e, rt, a, {
      maxTicks: 399,
      each: (t) => {
        maxX = Math.max(maxX, a.state.x);
        if (t === 398) at399 = { x: a.state.x, speed: ugvOf(a).state.speed, status: rt.info(a.id)?.status, phase: rt.info(a.id)?.phase };
      },
    });
    expect(maxX).toBeLessThanOrEqual(20 + ugvOf(a).body.arrivalToleranceM); // never further than an arrival at that point would be
    expect(at399).toMatchObject({ status: "running", phase: "following", speed: 0 });
    expect(a.state.x).toBeGreaterThan(19);
    const rest = run(e, rt, a, { from: 399 });
    expect(rest.info?.status).toBe("succeeded");
    expect(40 - a.state.x).toBeLessThanOrEqual(0.5);
    // The hold is in the trace: when it started and, when the next leg came, how long it lasted (F2b M4 follow-up).
    const holds = e.trace.ops("hold") as { state: string; queryId?: string; heldS?: number; reason?: string }[];
    expect(holds.map((h) => h.state)).toEqual(["start", "end", "start", "end"].slice(0, holds.length));
    expect(holds[0]).toMatchObject({ state: "start" });
    const ends = holds.filter((h) => h.state === "end");
    expect(ends[0]).toMatchObject({ reason: "leg" });
    expect(ends[0]?.heldS).toBeGreaterThan(30); // from about tick 100 to the leg at tick 400, in seconds at 0.1 s a tick
  });

  it("an eager plan and a lazy plan whose legs are never late trace no hold at all", () => {
    for (const lazy of [false, true]) {
      const e = env();
      if (lazy) e.planner.lazy = { legs: straight(3), ready: [3, 8, 14] };
      else e.planner.delayTicks = 14;
      const a = makeUgv(10, 10, 0);
      const rt = e.rt(a);
      rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
      run(e, rt, a);
      expect(e.trace.ops("hold"), lazy ? "lazy" : "eager").toEqual([]);
    }
  });
});

describe("a hold always ends (ADR-0037 sixth addition)", () => {
  it.each([
    ["budget_exceeded", "planning_budget"],
    ["not_found", "unreachable"],
  ] as const)("when the next leg never comes because the query ends %s, the hold ends with the query's code, where the vehicle stopped", (status, code) => {
    const e = env();
    e.planner.lazy = { legs: straight(3), ready: [3, 400, 405], failAtLeg: { index: 1, status } };
    const a = makeUgv(10, 10, 0);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    let heldAt: { x: number; y: number } | undefined;
    const r = run(e, rt, a, {
      each: (t) => {
        if (t === 300) {
          expect(rt.isRunning(a.id)).toBe(true); // still holding: the plan has not ended yet
          heldAt = { x: a.state.x, y: a.state.y };
        }
      },
    });
    expect(r.info?.status).toBe("failed");
    expect(r.info?.failure?.code).toBe(code);
    expect(r.lastTick).toBeGreaterThanOrEqual(400); // it held until the planner ended the query
    const ends = (e.trace.ops("hold") as { state: string; reason?: string }[]).filter((h) => h.state === "end");
    expect(ends).toEqual([expect.objectContaining({ reason: "query_ended" })]); // the hold ends in the trace with the query
    expect(r.lastTick).toBeLessThanOrEqual(402);
    expect(a.state.x).toBeCloseTo(heldAt?.x ?? Number.NaN, 12); // no creep during the hold
    expect(a.state.y).toBeCloseTo(heldAt?.y ?? Number.NaN, 12);
    expect(e.trace.ops("leg")).toHaveLength(1);
  });
});

describe("the pre-drive check, per leg, from the previous leg's predicted end pose", () => {
  it("fails the action kinematically_infeasible when a later leg is not drivable, names the leg, cancels the query, and the vehicle stays where it is", () => {
    const belief = new FakeSpatial();
    belief.add({ x0: 24, y0: 8, x1: 26, y1: 12 }); // on the second leg's route, known to the agent
    const e = env(belief);
    e.planner.lazy = { legs: straight(3), ready: [3, 8, 14] };
    const a = makeUgv(10, 10, 0);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    const r = run(e, rt, a);
    expect(r.info?.status).toBe("failed");
    expect(r.info?.failure?.code).toBe("kinematically_infeasible");
    expect(r.info?.failure?.message).toMatch(/leg 1/);
    expect(a.state.x).toBeGreaterThan(10.5); // it had already started on the first leg
    expect(a.state.x).toBeLessThan(24);
    expect(e.planner.cancelled).toContain(a.id);
    expect((e.trace.ops("predrive") as { leg?: number; ok: boolean; reason?: string }[]).map((p) => [p.leg, p.ok, p.reason])).toEqual([[0, true, undefined], [1, false, "contact"]]);
  });

  it("a first leg that cannot be driven fails before any movement (and a forward-only vehicle has no back-off)", () => {
    const belief = new FakeSpatial();
    belief.add({ x0: 14, y0: 8, x1: 16, y1: 12 });
    const e = env(belief);
    e.planner.lazy = { legs: straight(3), ready: [3, 8, 14] };
    const a = makeUgv(10, 10, 0);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    const r = run(e, rt, a);
    expect(r.info?.failure?.code).toBe("kinematically_infeasible");
    expect(a.state.x).toBe(10);
    expect(e.planner.cancelled).toContain(a.id);
  });

  it("a UAV has no pre-drive check: later legs are simply flown, and it hovers at the end of the ready waypoints", () => {
    const e = env();
    e.planner.lazy = { legs: straight(3), ready: [3, 250, 255] };
    const a = makeUav(10, 10, 20, true);
    const rt = e.rt(a);
    expect(rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0).ok).toBe(true);
    let hovered: { x: number; running: boolean } | undefined;
    run(e, rt, a, { maxTicks: 249, each: (t) => void (t === 248 && (hovered = { x: a.state.x, running: rt.isRunning(a.id) })) });
    expect(hovered?.running).toBe(true);
    expect(hovered?.x).toBeGreaterThan(19);
    expect(hovered?.x).toBeLessThanOrEqual(20 + 1e-6);
    const rest = run(e, rt, a, { from: 249 });
    expect(rest.info?.status).toBe("succeeded");
    expect(e.trace.ops("predrive")).toEqual([]);
  });
});

describe("stopping, preempting and the F2 rules", () => {
  it("stopping the action while legs are still being planned cancels the query", () => {
    const e = env();
    e.planner.lazy = { legs: straight(3), ready: [3, 1000, 1005] };
    const a = makeUgv(10, 10, 0);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(e, rt, a, { maxTicks: 50 });
    expect(rt.isRunning(a.id)).toBe(true);
    expect(e.planner.cancelled).toEqual([]);
    rt.preempt(a, "researcher", 50, 5);
    expect(e.planner.cancelled).toContain(a.id);
  });

  it("a reflex preemption while moving cancels it too", () => {
    const spatial = new FakeSpatial();
    spatial.add({ x0: 22, y0: 8, x1: 24, y1: 12 }); // in the world, not on the agent's map
    const e = env(new FakeSpatial(), true, spatial);
    e.planner.lazy = { legs: straight(3), ready: [3, 30, 60] };
    const a = makeUgv(10, 10, 0);
    e.prox.track(a);
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    const r = run(e, rt, a);
    expect(r.info?.status).toBe("preempted");
    expect(e.planner.cancelled).toContain(a.id);
  });

  it("replans from the current cell when the agent's map changes under the legs it has: executed legs are kept, the pending query is cancelled", () => {
    const belief = new FakeSpatial();
    const e = env(belief);
    e.planner.lazy = { legs: straight(3), ready: [3, 200, 205] };
    const a = makeUgv(10, 10, 0, { drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    let from: P | undefined;
    run(e, rt, a, {
      each: (t) => {
        if (t === 30) {
          belief.add({ x0: 17, y0: 8, x1: 18, y1: 12 }); // blocks the first leg's remaining route
          // The second plan routes around it, from wherever the vehicle is.
          e.planner.lazy = {
            legs: (q) => {
              from = [q.from.x, q.from.y];
              const mid: P = [q.from.x, 20];
              return [[[q.from.x, q.from.y], mid], [mid, [q.to.x, 20]], [[q.to.x, 20], [q.to.x, q.to.y]]];
            },
            ready: [3, 8, 14],
          };
        }
      },
      maxTicks: 3000,
    });
    expect(e.planner.cancelled).toContain(a.id); // the pending query of the first plan
    expect(e.planner.submissions).toHaveLength(2);
    expect(from?.[0]).toBeGreaterThan(10.5); // from where it was, not from the start
    expect(from?.[0]).toBeLessThan(17);
    const replans = e.trace.ops("replan") as { reason: string; interrupted?: boolean }[];
    expect(replans.map((r) => r.reason)).toEqual(["map_changed"]);
    expect(rt.info(a.id)?.status).toBe("succeeded");
  });

  it("the planner ending a lazy query because the map changed (an interruption) replans from where the vehicle is", () => {
    const e = env();
    e.planner.lazy = { legs: straight(3), ready: [3, 100, 105] };
    const a = makeUgv(10, 10, 0, { drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    let second: P | undefined;
    run(e, rt, a, {
      each: (t) => {
        if (t === 25) {
          e.planner.interruptNext(a.id);
          e.planner.lazy = {
            legs: (q) => {
              second = [q.from.x, q.from.y];
              return straight(2)(q);
            },
            ready: [3, 8],
          };
        }
      },
    });
    expect(e.planner.submissions).toHaveLength(2);
    expect(second?.[0]).toBeGreaterThan(10.5);
    expect(e.trace.ops("replan")).toEqual([expect.objectContaining({ reason: "map_changed", interrupted: true })]);
    expect(rt.info(a.id)?.status).toBe("succeeded");
    expect(40 - a.state.x).toBeLessThanOrEqual(0.5);
  });

  it("a later leg that fails has the eager codes, after the vehicle has moved", () => {
    for (const [status, code] of [["not_found", "unreachable"], ["budget_exceeded", "planning_budget"]] as const) {
      const e = env();
      e.planner.lazy = { legs: straight(3), ready: [3, 8, 14], failAtLeg: { index: 2, status } };
      const a = makeUgv(10, 10, 0);
      const rt = e.rt(a);
      rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
      const r = run(e, rt, a);
      expect(r.info?.failure?.code).toBe(code);
      expect(a.state.x).toBeGreaterThan(10.5);
    }
  });

  it("explore treats a lazy plan that turns out unreachable, or out of budget, after the vehicle started as unreachable for now, and for good at the third travel", () => {
    for (const [status, marks] of [["not_found", 1], ["budget_exceeded", 1]] as const) {
      const a = makeUgv(10, 10);
      const e = env();
      const fr = e.frontiers(a);
      fr.add("f-1", "r-00-00", 40, 10);
      e.planner.lazy = { legs: straight(3), ready: [3, 8, 14], failAtLeg: { index: 2, status } };
      const rt = e.rt(a, fr);
      expect(rt.start(a, "explore", {}, self(a), 0, 0).ok).toBe(true);
      run(e, rt, a, { maxTicks: 4000 });
      expect(fr.markCalls.length === 0 ? 0 : 1, status).toBe(marks);
    }
  });

  it("an explore target resolved on the way cancels the pending lazy query of its goTo", () => {
    const a = makeUgv(10, 10);
    const e = env();
    const fr = e.frontiers(a);
    fr.add("f-near", "r-00-00", 20, 10);
    e.planner.lazy = { legs: straight(3), ready: [3, 1000, 1005] }; // the later legs never come in time
    const rt = e.rt(a, fr);
    rt.start(a, "explore", {}, self(a), 0, 0);
    run(e, rt, a, {
      maxTicks: 200,
      each: (t) => {
        if (t === 60) {
          expect(e.planner.cancelled).toEqual([]);
          const g = fr.groups[0];
          if (g) g.resolved = true; // sensing resolved the target on the way
        }
      },
    });
    expect(e.planner.cancelled).toContain(a.id); // the inner goTo was stopped while it still had legs to plan
  });

  it("a back-off first, as ever, and only then the lazy query: the planner is asked once the vehicle is out of the band", () => {
    const spatial = new FakeSpatial();
    spatial.add({ x0: 0, y0: 30, x1: 40, y1: 31 }); // a long wall 0.6 m north of the vehicle
    const e = env(spatial, false, spatial);
    e.planner.lazy = { legs: straight(2), ready: [3, 8] };
    const a = makeUgv(20, 29.4, 0, { drive: "differential", reverseAllowed: true, turningRadiusM: 0 });
    const rt = e.rt(a);
    rt.start(a, "goTo", { xM: 20, yM: 18 }, self(a), 0, 0);
    const r = run(e, rt, a);
    expect(r.info?.status).toBe("succeeded");
    const kinds = (e.trace.ops("recovery") as { kind: string }[]).map((x) => x.kind);
    expect(kinds.length).toBeGreaterThan(0); // a back-off and, where it cannot reverse clear, an escape
    expect(e.planner.submissions).toHaveLength(1); // the lazy query was submitted after the recovery
    expect(e.trace.ops("leg").length).toBe(2);
  });
});
