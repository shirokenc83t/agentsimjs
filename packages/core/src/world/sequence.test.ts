import { describe, expect, it } from "vitest";
import { err, ok } from "../result.ts";
import type { CapabilityPort } from "../actions/ports.ts";
import type { DecisionEvent, DecisionRequest } from "./brain.ts";
import { MISSION_MAX_STEPS, resumesAfterPreemption, SequenceBrain, validateSequence, type SequenceStep } from "./sequence.ts";

// The `sequence` script mind (ADR-0036 addition of 2026-10-26): validation against the capability manifest, one step at a time, a stop on a refusal or a failure, a decision record
// note for every start.

const CAPS: Record<string, { vehicles: string[]; required?: string[] }> = {
  takeoff: { vehicles: ["uav"] },
  land: { vehicles: ["uav"] },
  goTo: { vehicles: ["uav", "ugv"], required: ["xM", "yM"] },
  explore: { vehicles: ["uav", "ugv"] },
  returnToBase: { vehicles: ["uav", "ugv"] },
  setTimer: { vehicles: ["uav", "ugv"] },
};
const caps: CapabilityPort = {
  list: () => Object.keys(CAPS).map((name) => ({ name, kind: name === "setTimer" ? "bookkeeping" : "action", paramsSchema: {} })),
  kind: (n) => (n === "setTimer" ? "bookkeeping" : "action"),
  injectable: () => true,
  validate: (n, p) => {
    const c = CAPS[n];
    if (!c) return err({ code: "unknown_capability", message: `no capability ${n}` });
    const o = (p ?? {}) as Record<string, unknown>;
    const missing = (c.required ?? []).filter((k) => typeof o[k] !== "number");
    return missing.length > 0 ? err({ code: "invalid_params", message: `missing ${missing.join(", ")}` }) : ok(p);
  },
  vehicles: (n) => CAPS[n]?.vehicles ?? [],
  scope: () => "self",
  preconditions: () => [],
};

const MISSION: SequenceStep[] = [{ action: "takeoff" }, { action: "goTo", args: { xM: 20, yM: 10 } }, { action: "explore", args: { radiusM: 25 } }, { action: "returnToBase" }, { action: "land" }];

const req = (events: DecisionEvent[]): DecisionRequest =>
  ({ agentId: "uav-001", tick: 0, simTimeS: 0, events, eventsDropped: 0, self: { kind: "uav", xM: 0, yM: 0, headingRad: 0, soc: 1, running: null, timers: [] }, beliefs: {}, space: {}, allowedActions: [], unavailable: [] }) as unknown as DecisionRequest;
const done = (name: string): DecisionEvent => ({ kind: "actionCompleted", actionId: `act-${name}`, name, result: {} });
const failed = (name: string, status: "failed" | "preempted", code: string): DecisionEvent => ({ kind: "actionFailed", actionId: `act-${name}`, name, status, code });

describe("validating a sequence", () => {
  it("accepts a list of actions the vehicle supports, with arguments the manifest accepts", () => {
    const v = validateSequence(MISSION, caps, "uav");
    expect(v.ok).toBe(true);
  });

  it("refuses an empty list and one over the limit, naming no step but saying why", () => {
    expect(validateSequence([], caps, "uav")).toMatchObject({ ok: false, error: { code: "mission_empty" } });
    const long = Array.from({ length: MISSION_MAX_STEPS + 1 }, () => ({ action: "explore" }));
    expect(validateSequence(long, caps, "uav")).toMatchObject({ ok: false, error: { code: "mission_too_long" } });
  });

  it("names the step (1-based) and its action for an unknown action, a bookkeeping capability, an unsupported vehicle and bad arguments", () => {
    expect(validateSequence([{ action: "takeoff" }, { action: "fly" }], caps, "uav")).toMatchObject({ ok: false, error: { code: "unknown_action", step: 2, action: "fly" } });
    expect(validateSequence([{ action: "setTimer" }], caps, "uav")).toMatchObject({ ok: false, error: { code: "unknown_action", step: 1 } });
    expect(validateSequence([{ action: "explore" }, { action: "takeoff" }], caps, "ugv")).toMatchObject({ ok: false, error: { code: "vehicle_unsupported", step: 2, action: "takeoff" } });
    expect(validateSequence([{ action: "takeoff" }, { action: "goTo", args: { xM: 3 } }], caps, "uav")).toMatchObject({ ok: false, error: { code: "invalid_args", step: 2, action: "goTo" } });
  });

  it("does not look at the order of the steps: whether a step can run is the start check's, step by step", () => {
    expect(validateSequence([{ action: "explore" }, { action: "takeoff" }], caps, "uav").ok).toBe(true);
  });
});

describe("the sequence mind", () => {
  it("starts step 1 at the start event and each next step when the one before ended done, with the step in its note", async () => {
    const b = new SequenceBrain("mission", MISSION);
    expect(b.tier).toBe("script");
    const first = await b.decide(req([{ kind: "start" }]));
    expect(first).toMatchObject({ decision: { kind: "action", name: "takeoff", params: {} }, mission: { step: 1, of: 5 } });
    const names = ["takeoff", "goTo", "explore", "returnToBase"];
    const started: string[] = [];
    for (const n of names) {
      const e = await b.decide(req([done(n)]));
      expect(e.decision.kind).toBe("action");
      if (e.decision.kind === "action") started.push(e.decision.name);
    }
    expect(started).toEqual(["goTo", "explore", "returnToBase", "land"]);
    const last = await b.decide(req([done("land")]));
    expect(last).toMatchObject({ decision: { kind: "idle" }, mission: { step: 5, of: 5, done: true } });
    expect((await b.decide(req([done("land")]))).decision.kind).toBe("idle"); // finished: stays idle
  });

  it("passes a step's arguments to its action as they are written", async () => {
    const b = new SequenceBrain("mission", MISSION);
    await b.decide(req([{ kind: "start" }]));
    const e2 = await b.decide(req([done("takeoff")]));
    expect(e2.decision).toEqual({ kind: "action", name: "goTo", params: { xM: 20, yM: 10 } });
  });

  it("leaves the running action alone for events that are not its end (perception, battery, timers, another action's end)", async () => {
    const b = new SequenceBrain("mission", MISSION);
    await b.decide(req([{ kind: "start" }]));
    for (const e of [{ kind: "batteryLow", soc: 0.2, level: 0.25 }, { kind: "timer", tag: "x" }, { kind: "frontierExhausted" }, done("returnToBase")] as DecisionEvent[]) {
      const env = await b.decide(req([e]));
      expect(env).toEqual({ decision: { kind: "idle" } });
    }
    expect(b.position).toBe(1 * 4 + 1);
  });

  it("stops at a refused step, with its index, the action and the code (no retry), and stays stopped", async () => {
    const b = new SequenceBrain("mission", [{ action: "explore" }, { action: "takeoff" }]);
    await b.decide(req([{ kind: "start" }]));
    const env = await b.decide(req([{ kind: "actionRejected", name: "explore", code: "precondition_failed" }]));
    expect(env).toMatchObject({ decision: { kind: "idle" }, mission: { step: 1, of: 2, stop: { code: "precondition_failed", action: "explore", status: "refused" } } });
    expect((await b.decide(req([done("explore")]))).decision.kind).toBe("idle");
  });

  it("stops at a failed step with its failure code", async () => {
    const b = new SequenceBrain("mission", MISSION);
    await b.decide(req([{ kind: "start" }]));
    await b.decide(req([done("takeoff")]));
    const env = await b.decide(req([failed("goTo", "failed", "unreachable")]));
    expect(env).toMatchObject({ decision: { kind: "idle" }, mission: { step: 2, of: 5, stop: { code: "unreachable", action: "goTo", status: "failed" } } });
  });

  it("stops at a preempted step (a reflex took the agent over) because no action resumes after a preemption", async () => {
    for (const a of ["takeoff", "land", "goTo", "explore", "returnToBase", "hold"]) expect(resumesAfterPreemption(a)).toBe(false);
    const b = new SequenceBrain("mission", MISSION);
    await b.decide(req([{ kind: "start" }]));
    await b.decide(req([done("takeoff")]));
    await b.decide(req([done("goTo")]));
    const env = await b.decide(req([failed("explore", "preempted", "battery_critical")]));
    expect(env).toMatchObject({ decision: { kind: "idle" }, mission: { step: 3, of: 5, stop: { code: "battery_critical", action: "explore", status: "preempted" } } });
  });

  it("holds its state as one number a snapshot can put back, and refuses a number that is not a state of this list", async () => {
    const b = new SequenceBrain("mission", MISSION);
    await b.decide(req([{ kind: "start" }]));
    await b.decide(req([done("takeoff")]));
    const at = b.position;
    const c = new SequenceBrain("mission", MISSION);
    c.restorePosition(at);
    expect(await c.decide(req([done("goTo")]))).toMatchObject({ decision: { name: "explore" }, mission: { step: 3 } });
    expect(() => c.restorePosition(-1)).toThrow(RangeError);
    expect(() => c.restorePosition(999)).toThrow(RangeError);
  });
});
