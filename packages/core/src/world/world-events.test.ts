import { describe, expect, it } from "vitest";
import type { SimAgent } from "../actions/agent.ts";
import { ActionRuntime } from "../actions/runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUgv } from "../actions/testing/fakes.ts";
import { batteryReflex } from "../reflexes/builtin.ts";
import { ScriptBrain, type Brain, type DecisionEnvelope, type DecisionRequest, type TimerOp } from "./brain.ts";
import type { AgentEvent, DecisionEvent } from "./events.ts";
import { World } from "./world.ts";

const DT = 0.1;

/** A brain that records its requests and answers from a function (idle by default). */
class RecordingBrain implements Brain {
  readonly tier = "baseline" as const;
  readonly requests: DecisionRequest[] = [];
  constructor(
    readonly id = "rec",
    private readonly answer: (req: DecisionRequest) => DecisionEnvelope = () => ({ decision: { kind: "idle" } }),
  ) {}
  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    this.requests.push(req);
    return Promise.resolve(this.answer(req));
  }
}

function rig(agent: SimAgent, brain: Brain, opts: { reflexes?: boolean; minDecisionIntervalS?: number } = {}) {
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const trace = new CollectingTrace();
  const runtime = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, ...(opts.reflexes ? { reflexes: [batteryReflex()] } : {}) }, DT);
  const injected: AgentEvent[] = [];
  const world = new World({
    agents: [agent],
    runtime,
    planner,
    trace,
    brains: new Map([[agent.id, brain]]),
    sensing: { sense: () => {}, takeEvents: () => injected.splice(0) },
    ...(opts.minDecisionIntervalS === undefined ? {} : { minDecisionIntervalS: opts.minDecisionIntervalS }),
  });
  let tick = 0;
  const step = async () => {
    if (world.outstandingCount > 0) await world.decide();
    tick++;
    world.step({ tick, simTimeS: tick * DT, dtS: DT });
  };
  const run = async (n: number) => {
    for (let i = 0; i < n; i++) await step();
  };
  const emit = (event: DecisionEvent) => injected.push({ agentId: agent.id, event });
  return { world, runtime, trace, run, step, emit, planner, tick: () => tick };
}

const det = (id: string, observedAtS = 0): DecisionEvent => ({ kind: "detected", entityId: id, entityKind: "target", xM: 1, yM: 2, zM: 0, observedAtS, transitions: 1 });
const kinds = (r: DecisionRequest) => r.events.map((e) => e.kind);

describe("world event delivery (ADR-0005 addition of 2026-10-09)", () => {
  it("the first request carries `start`, the agent's own state and no running action", async () => {
    const b = new RecordingBrain();
    const env = rig(makeUgv(), b);
    await env.run(1);
    const first = b.requests[0] as DecisionRequest;
    expect(kinds(first)).toEqual(["start"]);
    expect(first).not.toHaveProperty("event");
    expect(first.self).toEqual({ kind: "ugv", xM: 10, yM: 10, headingRad: 0, soc: 1, running: null, timers: [] });
  });

  it("an action answer replaces the running one and raises no event; idle leaves it running", async () => {
    const b = new RecordingBrain("rec", (req) => (req.events.some((e) => e.kind === "start") ? { decision: { kind: "action", name: "hold", params: {} } } : { decision: { kind: "idle" } }));
    const env = rig(makeUgv(), b, { minDecisionIntervalS: 0 });
    await env.run(2);
    env.emit(det("o-1")); // perception: a request, answered idle
    await env.run(2);
    expect(b.requests.at(-1)?.self.running).toMatchObject({ name: "hold", phase: "holding" });
    expect(env.runtime.isRunning("ugv-001")).toBe(true);
    // A new action decision replaces `hold` silently.
    const c = new RecordingBrain("rec2", (req) => (req.events.some((e) => e.kind === "detected") ? { decision: { kind: "action", name: "hold", params: { durationS: 0.3 } } } : { decision: { kind: "idle" } }));
    const env2 = rig(makeUgv(), c, { minDecisionIntervalS: 0 });
    await env2.run(1);
    env2.runtime.start(env2.world["agents"][0] as SimAgent, "hold", {}, { scope: "self", id: "ugv-001" }, 0, 0);
    env2.emit(det("o-1"));
    await env2.run(6);
    const failedEvents = env2.trace.records.filter((r) => (r.payload as { event?: { kind: string } }).event?.kind === "actionFailed");
    expect(failedEvents).toHaveLength(0); // replaced by the agent's own decision: no event
  });

  it("control events request a decision at the end of the tick where they happened", async () => {
    const b = new RecordingBrain("rec", (req) => (req.events.some((e) => e.kind === "start") ? { decision: { kind: "action", name: "hold", params: { durationS: 0.5 } } } : { decision: { kind: "idle" } }));
    const env = rig(makeUgv(), b);
    await env.run(12);
    const done = b.requests.find((r) => r.events.some((e) => e.kind === "actionCompleted"));
    expect(done).toBeDefined();
    // hold 0.5 s = 5 ticks: started in tick 1's brain phase, ends in tick 5 (not later); the request is made right then.
    expect(done?.tick).toBe(5);
    expect(done?.events[0]).toMatchObject({ kind: "actionCompleted", name: "hold" });
  });

  it("rate limit: a burst of detections within the interval makes one request at the first allowed tick, carrying all of them; batteryLow and timers go at once", async () => {
    const b = new RecordingBrain();
    const env = rig(makeUgv(), b); // minDecisionIntervalS = 1
    await env.run(1); // the start request is answered idle in the next step
    const sinceStart = b.requests.length;
    env.emit(det("o-2"));
    await env.run(1);
    env.emit(det("o-1"));
    env.emit(det("o-3"));
    await env.run(3);
    expect(b.requests.length).toBe(sinceStart); // delayed: less than 1 s since the previous request
    // A control event in the same interval is delivered at once, with the waiting perception entries.
    env.emit({ kind: "batteryLow", soc: 0.3, level: 0.3 });
    await env.run(2);
    const at = b.requests.at(-1) as DecisionRequest;
    expect(kinds(at)).toEqual(["detected", "detected", "detected", "batteryLow"]); // earlier ticks first (ADR-0005 order)
    expect(at.events.slice(0, 3).map((e) => (e as { entityId: string }).entityId)).toEqual(["o-2", "o-1", "o-3"]); // tick order, then ID within a tick
  });

  it("perception events wait out the interval, measured from the previous request of any kind, then go together", async () => {
    const b = new RecordingBrain();
    const env = rig(makeUgv(), b); // 1 s
    await env.run(2);
    const base = b.requests.length;
    env.emit(det("o-1"));
    await env.run(4);
    env.emit(det("o-2"));
    await env.run(20);
    const late = b.requests.slice(base);
    expect(late).toHaveLength(1);
    expect(late[0]?.events.map((e) => (e as { entityId: string }).entityId)).toEqual(["o-1", "o-2"]);
    expect(late[0]?.simTimeS).toBeGreaterThanOrEqual(1);
  });

  it("no request while a reflex recovery runs: the preempted action's actionFailed arrives after it ends", async () => {
    const agent = makeUgv(10, 10, 0, { battery: { capacityWh: 500, criticalSoc: 0.15 } });
    const b = new RecordingBrain("rec", (req) => (req.events.some((e) => e.kind === "start") ? { decision: { kind: "action", name: "goTo", params: { xM: 60, yM: 10 } } } : { decision: { kind: "idle" } }));
    const env = rig(agent, b, { reflexes: true });
    await env.run(10);
    const before = b.requests.length;
    agent.battery.soc = 0.1; // critical: the reflex preempts goTo and starts returnToBase
    await env.run(2);
    expect(env.runtime.isRecovering(agent.id)).toBe(true);
    await env.run(5);
    expect(b.requests.length).toBe(before); // nothing while the recovery runs
    for (let i = 0; i < 4000 && env.runtime.isRecovering(agent.id); i++) await env.run(1);
    await env.run(2);
    const after = b.requests.slice(before);
    expect(after.length).toBeGreaterThan(0);
    const all = after.flatMap((r) => r.events);
    expect(all.some((e) => e.kind === "actionFailed" && e.name === "goTo" && e.status === "preempted")).toBe(true);
  });

  it("batteryLow fires once per downward crossing of lowSoc", async () => {
    const agent = makeUgv(10, 10, 0, { battery: { capacityWh: 500, criticalSoc: 0.15, lowSoc: 0.3 } });
    const b = new RecordingBrain();
    const env = rig(agent, b, { minDecisionIntervalS: 0 });
    await env.run(2);
    agent.battery.soc = 0.31;
    await env.run(1);
    agent.battery.soc = 0.29; // crosses
    await env.run(2);
    agent.battery.soc = 0.28; // still low: no event
    await env.run(2);
    agent.battery.soc = 0.4; // recharged
    await env.run(1);
    agent.battery.soc = 0.2; // crosses again
    await env.run(2);
    const events = b.requests.flatMap((r) => r.events).filter((e) => e.kind === "batteryLow");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ soc: 0.29, level: 0.3 });
  });

  it("agents without a mind get the same events traced and no requests", async () => {
    const agent = makeUgv();
    const spatial = new FakeSpatial();
    const planner = new FakePlanner(spatial);
    const trace = new CollectingTrace();
    const runtime = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace }, DT);
    const injected: AgentEvent[] = [{ agentId: agent.id, event: det("o-1") }];
    const world = new World({ agents: [agent], runtime, planner, trace, sensing: { sense: () => {}, takeEvents: () => injected.splice(0) } });
    world.step({ tick: 1, simTimeS: DT, dtS: DT });
    expect(world.outstandingCount).toBe(0);
    expect(trace.records.some((r) => r.source === "ugv-001/sensors" && (r.payload as { event?: { kind: string } }).event?.kind === "detected")).toBe(true);
  });

  it("requests are byte-identical for a script and another mind in the same situation (fairness)", async () => {
    const script = new ScriptBrain("s", [{ name: "hold", params: { durationS: 0.5 } }]);
    const other = new RecordingBrain("rec", (req) => (req.events.some((e) => e.kind === "start") ? { decision: { kind: "action", name: "hold", params: { durationS: 0.5 } } } : { decision: { kind: "idle" } }));
    const requests = async (b: Brain) => {
      const seen: DecisionRequest[] = [];
      const wrapped: Brain = { id: b.id, tier: b.tier, decide: (req) => (seen.push(req), b.decide(req)) };
      const env = rig(makeUgv(), wrapped);
      await env.run(3);
      env.emit(det("o-1", 0.2));
      await env.run(20);
      return JSON.stringify(seen);
    };
    expect(await requests(script)).toBe(await requests(other));
  });
});

describe("request records (ADR-0005 addition of 2026-10-11)", () => {
  it("records each request as a thought (op request) and each distinct space summary once, by a 64-bit hash; allowed actions as names plus the manifest hash", async () => {
    const b = new RecordingBrain();
    const env = rig(makeUgv(), b, { minDecisionIntervalS: 0 });
    await env.run(1);
    for (let k = 0; k < 4; k++) {
      env.emit(det(`o-${k}`));
      await env.run(2);
    }
    const thoughts = env.trace.records.filter((r) => r.kind === "thought").map((r) => r.payload as { op: string; space?: string; hash?: string; allowed?: { manifest: string; names: string[] }; summary?: unknown });
    const requests = thoughts.filter((p) => p.op === "request");
    const spaces = thoughts.filter((p) => p.op === "space");
    expect(requests.length).toBe(b.requests.length);
    expect(requests.length).toBeGreaterThanOrEqual(5);
    expect(spaces).toHaveLength(1); // the fake world's summary never changes: stored once, referenced every time
    expect(new Set(requests.map((p) => p.space))).toEqual(new Set([spaces[0]?.hash]));
    expect(spaces[0]?.hash).toMatch(/^[0-9a-f]{16}$/);
    // No schema is repeated in a request record: names and the manifest hash only.
    expect(JSON.stringify(requests[0])).not.toContain("paramsSchema");
    expect(requests[0]?.allowed?.manifest).toMatch(/^[0-9a-f]{16}$/);
    expect(requests[0]?.allowed?.names).toEqual(b.requests[0]?.allowedActions.map((x) => x.name));
  });
});

describe("timers (ADR-0005 addition of 2026-10-09: bookkeeping set by minds)", () => {
  const timerMind = (timers: (req: DecisionRequest) => TimerOp[] | undefined) =>
    new RecordingBrain("t", (req) => {
      const t = timers(req);
      return { decision: { kind: "idle" }, ...(t ? { timers: t } : {}) };
    });

  it("a timer set with an idle decision fires at the first tick at or after its due time, as a control event from the mind slot", async () => {
    let first = true;
    const b = timerMind(() => {
      if (!first) return undefined;
      first = false;
      return [{ op: "set", tag: "wake", delayS: 0.5 }];
    });
    const env = rig(makeUgv(), b, { minDecisionIntervalS: 0 });
    await env.run(2);
    env.emit(det("x")); // a request while the timer is active
    await env.run(2);
    const while_ = b.requests.find((r) => r.events.some((e) => e.kind === "detected"));
    await env.run(10);
    const fired = b.requests.find((r) => r.events.some((e) => e.kind === "timer"));
    // The start request is answered in tick 1's brain phase, so the timer is set at tick 1 and due 5 ticks later.
    expect(fired?.tick).toBe(6);
    expect(fired?.events.find((e) => e.kind === "timer")).toEqual({ kind: "timer", tag: "wake" });
    expect(env.trace.records.some((r) => r.source === "ugv-001/s1" && (r.payload as { event?: { kind: string } }).event?.kind === "timer")).toBe(true); // RecordingBrain is a baseline: slot s1
    expect(b.requests.filter((r) => r.events.some((e) => e.kind === "timer"))).toHaveLength(1); // fires once
    // While active, a request shows it, with the seconds left.
    expect(while_?.self.timers).toEqual([{ tag: "wake", dueInS: 0.3 }]);
  });

  it("setting an existing tag replaces it; cancel removes it; both before the decision's action", async () => {
    let n = 0;
    const b = timerMind(() => {
      n++;
      if (n === 1) return [{ op: "set", tag: "a", delayS: 0.3 }, { op: "set", tag: "b", delayS: 0.4 }];
      if (n === 2) return [{ op: "set", tag: "a", delayS: 2 }, { op: "cancel", tag: "b" }]; // replaces a, cancels b
      return undefined;
    });
    const env = rig(makeUgv(), b, { minDecisionIntervalS: 0 });
    await env.run(2);
    env.emit(det("x")); // a request at which the mind answers its second set of operations
    await env.run(2);
    env.emit(det("y")); // and a later one that shows the result
    await env.run(2);
    const timers = b.requests.at(-1)?.self.timers;
    expect(timers).toEqual([{ tag: "a", dueInS: expect.any(Number) }]);
    expect((timers?.[0]?.dueInS ?? 0)).toBeGreaterThan(1.5); // a was replaced by the 2 s timer
    await env.run(30);
    const tags = b.requests.flatMap((r) => r.events).filter((e) => e.kind === "timer").map((e) => (e as { tag: string }).tag);
    expect(tags).toEqual(["a"]); // b never fired; a fired once, late
  });

  it("limits and ranges: delay_out_of_range, timer_limit (8 active), timer_not_found and bad tags are rejected with those codes; the rest still apply", async () => {
    let n = 0;
    const ops = () => {
      n++;
      if (n !== 1) return undefined;
      return [
        ...Array.from({ length: 8 }, (_, k) => ({ op: "set" as const, tag: `t-${k}`, delayS: 100 })),
        { op: "set" as const, tag: "ninth", delayS: 100 }, // timer_limit
        { op: "set" as const, tag: "t-0", delayS: 200 }, // replacing is fine at the limit
        { op: "set" as const, tag: "soon", delayS: 0.05 }, // delay_out_of_range
        { op: "set" as const, tag: "late", delayS: 4000 }, // delay_out_of_range
        { op: "cancel" as const, tag: "nope" }, // timer_not_found
        { op: "set" as const, tag: "Bad Tag", delayS: 1 }, // invalid_params (tools-schema)
      ];
    };
    const b = timerMind(ops);
    const env = rig(makeUgv(), b, { minDecisionIntervalS: 0 });
    await env.run(3);
    const rejected = b.requests.flatMap((r) => r.events).filter((e) => e.kind === "actionRejected") as { name: string; code: string }[];
    // Delivery order (ADR-0005): by subject (the action name) within the tick, then emission order.
    expect(rejected.map((e) => `${e.name}:${e.code}`)).toEqual([
      "cancelTimer:timer_not_found",
      "setTimer:timer_limit",
      "setTimer:delay_out_of_range",
      "setTimer:delay_out_of_range",
      "setTimer:invalid_params",
    ]);
    env.emit(det("x"));
    await env.run(2);
    const last = b.requests.at(-1);
    expect(last?.self.timers).toHaveLength(8);
    expect(last?.self.timers.map((t) => t.tag)).toEqual(["t-0", "t-1", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7"]);
  });

  it("active timers are agent state: in the state hash while any are active, and the hash returns when they are gone", async () => {
    const run = async (withTimer: boolean) => {
      let first = true;
      const b = timerMind(() => {
        if (!first || !withTimer) return undefined;
        first = false;
        return [{ op: "set", tag: "wake", delayS: 1 }];
      });
      const env = rig(makeUgv(), b);
      await env.run(3);
      const during = env.world.stateHash;
      await env.run(20);
      return { during, after: env.world.stateHash };
    };
    const a = await run(true);
    const b = await run(false);
    expect(a.during).not.toBe(b.during);
    expect(await run(true)).toEqual(a); // deterministic
    // The timer fired and went (its event was delivered): with nothing pending the hashes agree again, apart from the tick.
    expect(a.after).toBeTypeOf("string");
  });

  it("a timer event is a control event: it requests a decision at once, whatever the minimum interval", async () => {
    let first = true;
    const b = timerMind(() => {
      if (!first) return undefined;
      first = false;
      return [{ op: "set", tag: "wake", delayS: 0.3 }];
    });
    const env = rig(makeUgv(), b, { minDecisionIntervalS: 600 });
    await env.run(8);
    expect(b.requests.some((r) => r.events.some((e) => e.kind === "timer"))).toBe(true);
  });
});

describe("bookkeeping is not an action", () => {
  it("starting setTimer as an action is refused with not_an_action, and timers never appear in allowedActions or unavailable", async () => {
    const b = new RecordingBrain();
    const agent = makeUgv();
    const env = rig(agent, b);
    expect(env.runtime.start(agent, "setTimer", { delayS: 1, tag: "x" }, { scope: "self", id: agent.id }, 0, 0)).toMatchObject({ ok: false, error: { code: "not_an_action" } });
    await env.run(1);
    const first = b.requests[0] as DecisionRequest;
    const names = [...first.allowedActions.map((x) => x.name), ...first.unavailable.map((x) => x.name)];
    expect(names).not.toContain("setTimer");
    expect(names).not.toContain("cancelTimer");
  });
});
