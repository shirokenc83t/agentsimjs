import { describe, expect, it } from "vitest";
import type { SimAgent } from "../actions/agent.ts";
import { ActionRuntime, type RuntimeSnapshot } from "../actions/runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUgv } from "../actions/testing/fakes.ts";
import { decodeValue, encodeValue } from "../snapshot/codec.ts";
import type { Brain, DecisionEnvelope, DecisionRequest } from "./brain.ts";
import type { AgentEvent, DecisionEvent } from "./events.ts";
import { World, type WorldSnapshot } from "./world.ts";

// F4b M1 (T-144): the task list in the world (ADR-0005 addition of 2026-11-08, ADR-0035 addition of the same day). An answer may carry `task` (the steps) and `step` (the one its action works on); the world,
// never the mind, marks each step from the action's outcome, traces the list and each step, hashes the list only when there is one, and keeps it in a snapshot.

const DT = 0.1;

/** A brain that answers by its request count (the first request is the first answer) and keeps its requests. */
class Scripted implements Brain {
  readonly tier = "baseline" as const;
  readonly requests: DecisionRequest[] = [];
  count = 0;
  constructor(
    readonly id: string,
    private readonly answers: readonly ((req: DecisionRequest) => DecisionEnvelope)[],
  ) {}
  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    this.requests.push(req);
    const f = this.answers[this.count++];
    return Promise.resolve(f ? f(req) : { decision: { kind: "idle" } });
  }
}

const hold = (durationS: number) => ({ kind: "action" as const, name: "hold", params: { durationS } });

interface Rig {
  readonly agent: SimAgent;
  readonly planner: FakePlanner;
  readonly spatial: FakeSpatial;
  readonly trace: CollectingTrace;
  runtime: ActionRuntime;
  world: World;
  readonly brain: Scripted;
  readonly injected: AgentEvent[];
  tick: number;
}

function build(answers: ConstructorParameters<typeof Scripted>[1], genesis = true): Rig {
  const agent = makeUgv();
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const trace = new CollectingTrace();
  const runtime = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace }, DT);
  const brain = new Scripted("scripted", answers);
  const injected: AgentEvent[] = [];
  const world = new World({ agents: [agent], runtime, planner, trace, brains: new Map([[agent.id, brain]]), sensing: { sense: () => {}, takeEvents: () => injected.splice(0) }, minDecisionIntervalS: 0, genesis });
  return { agent, planner, spatial, trace, runtime, world, brain, injected, tick: 0 };
}

async function run(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (r.world.outstandingCount > 0) await r.world.decide();
    r.tick++;
    r.world.step({ tick: r.tick, simTimeS: r.tick * DT, dtS: DT });
  }
}

const lastSelf = (r: Rig) => (r.brain.requests.at(-1) as DecisionRequest).self;
const ops = (r: Rig, op: string) => r.trace.records.filter((x) => (x.payload as { op?: string }).op === op);
const det = (id: string): DecisionEvent => ({ kind: "detected", entityId: id, entityKind: "target", xM: 1, yM: 2, zM: 0, observedAtS: 0, transitions: 1 });
/** The index in `trace.records` of the record a `causeIds` entry names. */
const causeOf = (r: Rig, rec: { causeIds?: readonly string[] }) => r.trace.records[r.trace.at(rec.causeIds?.[0]) as number];

const TWO = { steps: [{ text: "hold a little", action: "hold", params: { durationS: 0.3 } }, { text: "then wait" }] };

describe("the task list in the world (T-144)", () => {
  it("an answer's list replaces the agent's list with every step pending, shows in the next request, and is traced from the mind's slot", async () => {
    const r = build([() => ({ decision: { kind: "idle" }, task: TWO })]);
    await run(r, 1);
    r.injected.push({ agentId: r.agent.id, event: det("o-1") }); // a perception event: the mind is asked again
    await run(r, 3);
    expect(lastSelf(r).task).toEqual({ steps: [{ text: "hold a little", action: "hold", params: { durationS: 0.3 }, status: "pending" }, { text: "then wait", status: "pending" }] });
    const [rec] = ops(r, "task");
    expect(rec).toMatchObject({ source: "ugv-001/s1", kind: "event", agentId: "ugv-001", payload: { op: "task", steps: TWO.steps } });
  });

  it("the action bound to step n marks it running, `actionCompleted` marks it done (caused by the outcome record), and the last outcome is kept", async () => {
    const r = build([() => ({ decision: hold(0.3), task: TWO, step: 1 }), () => ({ decision: { kind: "idle" } })]);
    await run(r, 1);
    expect(r.world.snapshot().tasks?.[0]?.steps[0]).toMatchObject({ status: "running" });
    await run(r, 6);
    const self = lastSelf(r);
    expect(self.task?.steps.map((s) => s.status)).toEqual(["done", "pending"]);
    expect(self.task?.last).toEqual({ step: 1, status: "done", action: "hold" });
    expect(self.task?.running).toBeUndefined();
    const steps = ops(r, "task_step");
    expect(steps.map((x) => (x.payload as { status: string }).status)).toEqual(["running", "done"]);
    // `running` is caused by the decision that started the action; `done` by the record of the action's outcome.
    const [running, done] = steps as unknown as { payload: { actionId: string }; causeIds?: string[] }[];
    expect(causeOf(r, running as { causeIds?: string[] })?.payload).toMatchObject({ op: "decision" });
    expect(causeOf(r, done as { causeIds?: string[] })?.payload).toMatchObject({ op: "end", name: "hold", status: "succeeded" });
    expect((running as { payload: { actionId: string } }).payload.actionId).toBe((done as { payload: { actionId: string } }).payload.actionId);
  });

  it("`actionFailed` (the action failed) marks the step failed, with the code", async () => {
    const r = build([() => ({ decision: { kind: "action", name: "goTo", params: { xM: 30, yM: 30 } }, task: { steps: [{ text: "go" }] }, step: 1 })]);
    r.planner.status = "not_found";
    await run(r, 8);
    const self = lastSelf(r);
    expect(self.task?.steps[0]?.status).toBe("failed");
    expect(self.task?.last).toMatchObject({ step: 1, status: "failed", action: "goTo" });
    expect(self.task?.last?.code).toEqual(expect.any(String));
  });

  it("a step whose action is replaced by another is failed as preempted; the new action works on its own step", async () => {
    const r = build([() => ({ decision: hold(30), task: TWO, step: 1 }), () => ({ decision: hold(0.3), step: 2 }), () => ({ decision: { kind: "idle" } })]);
    await run(r, 1);
    r.injected.push({ agentId: r.agent.id, event: det("o-1") });
    await run(r, 2);
    const list = r.world.snapshot().tasks?.[0];
    expect(list?.steps.map((s) => s.status)).toEqual(["failed", "running"]);
    expect(list?.last).toMatchObject({ step: 1, status: "preempted", action: "hold" });
  });

  it("an action the start check rejects marks its step failed as refused, and the rejection still reaches the mind as an event", async () => {
    const r = build([() => ({ decision: { kind: "action", name: "takeoff", params: { altitudeM: 10 } }, task: { steps: [{ text: "fly" }] }, step: 1 })]);
    await run(r, 3);
    const self = lastSelf(r);
    expect(self.task?.steps[0]?.status).toBe("failed");
    expect(self.task?.last).toMatchObject({ step: 1, status: "refused", action: "takeoff" });
    expect(r.brain.requests.at(-1)?.events.some((e) => e.kind === "actionRejected" && e.name === "takeoff")).toBe(true);
  });

  it("a new list resets every status and the last outcome", async () => {
    const r = build([() => ({ decision: hold(0.3), task: TWO, step: 1 }), () => ({ decision: { kind: "idle" }, task: { steps: [{ text: "something else" }] } }), () => ({ decision: { kind: "idle" } })]);
    await run(r, 6);
    r.injected.push({ agentId: r.agent.id, event: det("o-1") });
    await run(r, 3);
    expect(lastSelf(r).task).toEqual({ steps: [{ text: "something else", status: "pending" }] });
  });

  it("an empty list clears the agent's list: the field is gone from the request and the hash is as before", async () => {
    const quiet = build([() => ({ decision: { kind: "idle" } })]);
    await run(quiet, 1);
    const r = build([() => ({ decision: { kind: "idle" }, task: TWO }), () => ({ decision: { kind: "idle" }, task: { steps: [] } }), () => ({ decision: { kind: "idle" } })]);
    await run(r, 1);
    expect(r.world.snapshot().tasks).toBeDefined();
    r.injected.push({ agentId: r.agent.id, event: det("o-1") });
    await run(r, 2);
    r.injected.push({ agentId: r.agent.id, event: det("o-2") });
    await run(r, 2);
    expect(r.world.snapshot().tasks).toBeUndefined();
    expect(lastSelf(r)).not.toHaveProperty("task");
  });

  it("refuses a list over 16 steps (task_too_many_steps) and a step text over 200 characters (task_step_too_long): nothing changes and the mind hears of it", async () => {
    const many = { steps: Array.from({ length: 17 }, (_, i) => ({ text: `step ${i + 1}` })) };
    const long = { steps: [{ text: "x".repeat(201) }] };
    const okay = { steps: Array.from({ length: 16 }, (_, i) => ({ text: i === 0 ? "x".repeat(200) : `step ${i + 1}` })) };
    const r = build([() => ({ decision: { kind: "idle" }, task: many }), () => ({ decision: { kind: "idle" }, task: long }), () => ({ decision: { kind: "idle" }, task: okay }), () => ({ decision: { kind: "idle" } })]);
    // A rejection is a control event: it asks the mind at once, so each refused list is answered by the next request.
    await run(r, 1);
    expect(r.world.snapshot().tasks).toBeUndefined();
    await run(r, 1);
    expect(r.brain.requests[1]?.events.some((e) => e.kind === "actionRejected" && e.name === "task" && e.code === "task_too_many_steps")).toBe(true);
    expect(r.world.snapshot().tasks).toBeUndefined();
    await run(r, 1);
    expect(r.brain.requests[2]?.events.some((e) => e.kind === "actionRejected" && e.name === "task" && e.code === "task_step_too_long")).toBe(true);
    // Both limits are inclusive: the list of 16 steps, one of 200 characters, that answered the refusals is accepted.
    expect(r.world.snapshot().tasks?.[0]?.steps).toHaveLength(16);
  });

  it("a parameter error (a step without text) is refused as invalid_params", async () => {
    const r = build([() => ({ decision: { kind: "idle" }, task: { steps: [{ action: "hold" }] } as never }), () => ({ decision: { kind: "idle" } })]);
    await run(r, 3);
    expect(r.brain.requests.at(-1)?.events.some((e) => e.kind === "actionRejected" && e.name === "task" && e.code === "invalid_params")).toBe(true);
  });

  it("a step number outside the list binds nothing", async () => {
    const r = build([() => ({ decision: hold(0.3), task: TWO, step: 9 })]);
    await run(r, 3);
    expect(r.world.snapshot().tasks?.[0]?.steps.map((s) => s.status)).toEqual(["pending", "pending"]);
  });

  it("the decision record carries the list's state as a MissionNote (step, of, done, stop)", async () => {
    const r = build([() => ({ decision: hold(0.3), task: { steps: [{ text: "only" }] }, step: 1 }), () => ({ decision: { kind: "idle" } })]);
    await run(r, 6);
    const decisions = ops(r, "decision").map((x) => x as unknown as { payload: Record<string, unknown> });
    expect(decisions[0]?.payload).toMatchObject({ step: 1, of: 1 });
    expect(decisions[0]?.payload).not.toHaveProperty("done");
    expect(decisions[1]?.payload).toMatchObject({ step: 1, of: 1, done: true });
    const f = build([() => ({ decision: { kind: "action", name: "goTo", params: { xM: 30, yM: 30 } }, task: { steps: [{ text: "go" }] }, step: 1 }), () => ({ decision: { kind: "idle" } })]);
    f.planner.status = "not_found";
    await run(f, 8);
    const second = ops(f, "decision")[1] as unknown as { payload: { stop?: { status: string; action: string } } };
    expect(second.payload.stop).toMatchObject({ status: "failed", action: "goTo" });
  });

  it("a list the world refuses is not the one the decision record describes: the MissionNote is the previous list's (or absent when there was none)", async () => {
    const tooLong = { steps: [{ text: "x".repeat(201) }] };
    const tooMany = { steps: Array.from({ length: 17 }, (_, i) => ({ text: `s${i}` })) };
    const invalid = { steps: [{ action: "hold" }] } as never;
    for (const refused of [tooLong, tooMany, invalid]) {
      // With a previous list (two steps): the record keeps describing it.
      const withList = build([() => ({ decision: hold(5), task: TWO, step: 1 }), () => ({ decision: { kind: "idle" }, task: refused }), () => ({ decision: { kind: "idle" } })]);
      await run(withList, 1);
      withList.injected.push({ agentId: withList.agent.id, event: det("o-1") });
      await run(withList, 3);
      const second = ops(withList, "decision")[1] as unknown as { payload: Record<string, unknown> };
      expect(second.payload, JSON.stringify(refused).slice(0, 40)).toMatchObject({ of: 2, step: 1 });
      expect(withList.world.snapshot().tasks?.[0]?.steps).toHaveLength(2);
      // With none: the record says nothing of a list.
      const without = build([() => ({ decision: { kind: "idle" }, task: refused })]);
      await run(without, 1);
      const only = ops(without, "decision")[0] as unknown as { payload: Record<string, unknown> };
      expect(only.payload).not.toHaveProperty("of");
      expect(only.payload).not.toHaveProperty("step");
      expect(without.world.snapshot().tasks).toBeUndefined();
    }
    // A list the world accepts is described at once, by the same check.
    const ok = build([() => ({ decision: { kind: "idle" }, task: TWO })]);
    await run(ok, 1);
    expect((ops(ok, "decision")[0] as unknown as { payload: Record<string, unknown> }).payload).toMatchObject({ of: 2, step: 1 });
  });

  it("a decision that goes on with the action its step is already bound to leaves the list and the trace as they are (no second `running` record); one that names a pending step binds it to the running action", async () => {
    const r = build([
      () => ({ decision: hold(5), task: TWO, step: 1 }),
      (req) => ({ decision: { kind: "idle" }, continued: { actionId: (req.self.running as { actionId: string }).actionId }, step: 1 }),
      (req) => ({ decision: { kind: "idle" }, continued: { actionId: (req.self.running as { actionId: string }).actionId }, step: 2 }),
      () => ({ decision: { kind: "idle" } }),
    ]);
    await run(r, 1);
    expect(ops(r, "task_step")).toHaveLength(1);
    r.injected.push({ agentId: r.agent.id, event: det("o-1") });
    await run(r, 2);
    // Step 1 again: nothing new is recorded.
    expect(ops(r, "task_step")).toHaveLength(1);
    expect(r.world.snapshot().tasks?.[0]?.steps.map((s) => s.status)).toEqual(["running", "pending"]);
    r.injected.push({ agentId: r.agent.id, event: det("o-2") });
    await run(r, 2);
    // Step 2 named while the action runs: the same action is now bound to it too (a record for it).
    expect(ops(r, "task_step")).toHaveLength(2);
    expect(r.world.snapshot().tasks?.[0]?.steps.map((s) => s.status)).toEqual(["running", "running"]);
    // Both end with the action.
    await run(r, 60);
    expect(r.world.snapshot().tasks?.[0]?.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("a run without lists hashes as before, and a list changes the hash only once it exists", async () => {
    const a = build([() => ({ decision: hold(0.3) })]);
    const b = build([() => ({ decision: hold(0.3) })]);
    await run(a, 3);
    await run(b, 3);
    expect(b.world.stateHash).toBe(a.world.stateHash);
    expect(a.world.snapshot().tasks).toBeUndefined();
    const c = build([() => ({ decision: hold(0.3), task: TWO })]);
    await run(c, 3);
    expect(c.world.stateHash).not.toBe(a.world.stateHash);
  });
});

describe("the task list in a snapshot (T-144)", () => {
  async function twinOf(a: Rig, answers: ConstructorParameters<typeof Scripted>[1], n: number): Promise<Rig> {
    const world = decodeValue(encodeValue(a.world.snapshot())) as WorldSnapshot;
    const runtime = decodeValue(encodeValue(a.runtime.snapshot())) as RuntimeSnapshot;
    const twin = build(answers);
    await run(twin, n);
    twin.runtime = new ActionRuntime({ planner: twin.planner, spatial: twin.spatial, capabilities: fakeCapabilities, trace: twin.trace }, DT);
    twin.runtime.restore(runtime, [twin.agent]);
    const brain = new Scripted("scripted", answers);
    brain.count = a.brain.count;
    const b: Rig = { ...twin, brain, runtime: twin.runtime, world: new World({ agents: [twin.agent], runtime: twin.runtime, planner: twin.planner, trace: twin.trace, brains: new Map([[twin.agent.id, brain]]), sensing: { sense: () => {}, takeEvents: () => [] }, minDecisionIntervalS: 0, genesis: false }), tick: n };
    b.world.restore(world);
    return b;
  }

  it("round-trips a list with a running step: snapshot(restore(snapshot)) is byte-identical, the hash is checked, and the list goes on in the restored world", async () => {
    const answers = [() => ({ decision: hold(0.5), task: TWO, step: 1 }), () => ({ decision: { kind: "idle" as const } })];
    const a = build(answers);
    await run(a, 3);
    const snap = a.world.snapshot();
    expect(snap.tasks?.[0]?.steps[0]?.status).toBe("running");
    const b = await twinOf(a, answers, 3);
    expect(encodeValue(b.world.snapshot()), "snapshot(restore(snapshot)) is byte-identical").toEqual(encodeValue(snap));
    expect(b.world.stateHash).toBe(a.world.stateHash);
    await run(a, 6);
    await run(b, 6);
    expect(b.world.snapshot().tasks?.[0]?.steps.map((s) => s.status)).toEqual(["done", "pending"]);
    expect(encodeValue(b.world.snapshot())).toEqual(encodeValue(a.world.snapshot()));
    expect(b.world.stateHash).toBe(a.world.stateHash);
  });

  it("a restored world that disagrees on the list is refused by the hash check", async () => {
    const a = build([() => ({ decision: { kind: "idle" }, task: TWO })]);
    await run(a, 2);
    const s = a.world.snapshot();
    const b = build([], false);
    const { tasks: _tasks, ...without } = s;
    expect(() => b.world.restore(without)).toThrow(/differs from the snapshot/);
  });
});
