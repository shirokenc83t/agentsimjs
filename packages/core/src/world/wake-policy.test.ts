import { describe, expect, it } from "vitest";
import type { SimAgent } from "../actions/agent.ts";
import { ActionRuntime } from "../actions/runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUgv } from "../actions/testing/fakes.ts";
import type { Brain, DecisionEnvelope, DecisionRequest } from "./brain.ts";
import type { AgentEvent, DecisionEvent } from "./events.ts";
import { World } from "./world.ts";

// F4b M1 (T-145): the wake policy (ADR-0005 addition of 2026-11-08). With `wake: "task"`, while the agent has a running action its perception events stay in the inbox and do not ask for a decision; control
// events ask at once and the events that waited go with them; with no running action everything asks as before. The decision record counts the perception events that rode along (`held`).

const DT = 0.1;

class Brainy implements Brain {
  readonly tier = "baseline" as const;
  readonly requests: DecisionRequest[] = [];
  count = 0;
  constructor(
    readonly id: string,
    readonly wake: "all" | "task" | undefined,
    private readonly answers: readonly ((req: DecisionRequest) => DecisionEnvelope)[],
  ) {}
  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    this.requests.push(req);
    const f = this.answers[this.count++];
    return Promise.resolve(f ? f(req) : { decision: { kind: "idle" } });
  }
}

function build(wake: "all" | "task" | undefined, answers: ConstructorParameters<typeof Brainy>[2]) {
  const agent: SimAgent = makeUgv();
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const trace = new CollectingTrace();
  const runtime = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace }, DT);
  const brain = new Brainy("brainy", wake, answers);
  const injected: AgentEvent[] = [];
  const world = new World({ agents: [agent], runtime, planner, trace, brains: new Map([[agent.id, brain]]), sensing: { sense: () => {}, takeEvents: () => injected.splice(0) }, minDecisionIntervalS: 0 });
  let tick = 0;
  const run = async (n: number) => {
    for (let i = 0; i < n; i++) {
      if (world.outstandingCount > 0) await world.decide();
      tick++;
      world.step({ tick, simTimeS: tick * DT, dtS: DT });
    }
  };
  const emit = (event: DecisionEvent) => injected.push({ agentId: agent.id, event });
  return { brain, trace, run, emit, world };
}

const hold = (durationS: number) => ({ kind: "action" as const, name: "hold", params: { durationS } });
const det = (id: string): DecisionEvent => ({ kind: "detected", entityId: id, entityKind: "target", xM: 1, yM: 2, zM: 0, observedAtS: 0, transitions: 1 });
const decisions = (r: { trace: CollectingTrace }) => r.trace.records.map((x) => x.payload as Record<string, unknown>).filter((p) => p["op"] === "decision");

describe("the wake policy (T-145)", () => {
  it("`all` (and a mind that says nothing): a perception event asks for a decision while an action runs, as before", async () => {
    for (const wake of [undefined, "all" as const]) {
      const r = build(wake, [() => ({ decision: hold(5) })]);
      await r.run(3);
      expect(r.brain.requests).toHaveLength(1);
      r.emit(det("o-1"));
      await r.run(2);
      expect(r.brain.requests, String(wake)).toHaveLength(2);
      expect(r.brain.requests[1]?.events.map((e) => e.kind)).toEqual(["detected"]);
      expect(decisions(r).every((d) => !("held" in d))).toBe(true);
    }
  });

  it("`task`: perception events wait while an action runs (merged, not lost), and the action's end asks at once with them; the decision record counts them as held", async () => {
    const r = build("task", [() => ({ decision: hold(1) })]);
    await r.run(3);
    r.emit(det("o-1"));
    await r.run(2);
    r.emit(det("o-2"));
    r.emit({ kind: "lost", entityId: "o-1", entityKind: "target", lastSeenS: 0.4, transitions: 1 });
    await r.run(3);
    expect(r.brain.requests, "no request while the action runs").toHaveLength(1);
    await r.run(12);
    expect(r.brain.requests).toHaveLength(2);
    const second = r.brain.requests[1] as DecisionRequest;
    // Events are delivered by the tick they arrived in, then by kind: what waited comes before the action's end, and o-1's detection and loss are one entry (coalesced).
    expect(second.events.map((e) => e.kind)).toEqual(["lost", "detected", "actionCompleted"]);
    expect((second.events.find((e) => e.kind === "lost") as { transitions: number }).transitions).toBeGreaterThan(1);
    const ds = decisions(r);
    expect(ds[0]).not.toHaveProperty("held");
    expect(ds[1]).toMatchObject({ held: 2 });
  });

  it("`task`: a control event asks at once even while an action runs, and the perception events that waited ride along", async () => {
    const r = build("task", [() => ({ decision: hold(5), timers: [{ op: "set", tag: "check", delayS: 0.5 }] }), () => ({ decision: { kind: "idle" } })]);
    await r.run(2);
    r.emit(det("o-1"));
    await r.run(2);
    expect(r.brain.requests).toHaveLength(1);
    await r.run(5); // the timer fires at 0.5 s while the hold goes on
    expect(r.brain.requests).toHaveLength(2);
    const second = r.brain.requests[1] as DecisionRequest;
    expect(second.events.map((e) => e.kind)).toEqual(["detected", "timer"]);
    expect(second.self.running).toMatchObject({ name: "hold" });
    expect(decisions(r)[1]).toMatchObject({ held: 1 });
  });

  it("`task`: with no running action every event asks as before", async () => {
    const r = build("task", [() => ({ decision: { kind: "idle" } })]);
    await r.run(2);
    expect(r.brain.requests).toHaveLength(1);
    r.emit(det("o-1"));
    await r.run(2);
    expect(r.brain.requests).toHaveLength(2);
    expect(r.brain.requests[1]?.events.map((e) => e.kind)).toEqual(["detected"]);
    expect(decisions(r)[1]).not.toHaveProperty("held");
  });

  it("the request is the same for both policies: the wake policy is not in it, so fairness holds", async () => {
    const a = build("task", [() => ({ decision: hold(5) })]);
    const b = build("all", [() => ({ decision: hold(5) })]);
    await a.run(1);
    await b.run(1);
    expect(JSON.stringify(a.brain.requests[0])).toBe(JSON.stringify(b.brain.requests[0]));
  });
});
