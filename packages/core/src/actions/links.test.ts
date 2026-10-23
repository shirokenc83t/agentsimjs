import { describe, expect, it } from "vitest";
import { defaultReflexes } from "../reflexes/builtin.ts";
import type { SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import type { PlanResult } from "./ports.ts";
import { CollectingTrace, fakeCapabilities, FakeContact, FakePlanner, FakeProximity, FakeSpatial, makeUgv } from "./testing/fakes.ts";

// The links of the trace (ADR-0004): trusted code gives a record its `parentId` (an action's start for what happens during the action) and its `causeIds` (the record
// that made it happen, where one exists). A link names a record of the same run written before the record that carries it.

const DT = 0.1;

function setup(proximityRangeM = 2) {
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(new FakeSpatial());
  const trace = new CollectingTrace();
  const proximity = new FakeProximity(spatial, proximityRangeM);
  const contact = new FakeContact();
  const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, reflexes: defaultReflexes(), proximity, contact }, DT);
  return { planner, spatial, trace, rt, proximity };
}

const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

function run(env: ReturnType<typeof setup>, a: SimAgent, from = 0, max = 5000): number {
  env.proximity.track(a);
  let t = from;
  for (; t < from + max; t++) {
    env.planner.advance(t);
    env.rt.tick(a, t, t * DT);
    if (!env.rt.isRunning(a.id)) break;
  }
  return t;
}

const op = (r: { payload: unknown }): string | undefined => (r.payload as { op?: string } | null)?.op;
const indexOfOp = (env: ReturnType<typeof setup>, name: string, from = 0): number => env.trace.records.findIndex((r, i) => i >= from && op(r) === name);

/** Every link of the trace names a record that was written before the one that carries it. */
function expectLinksBackwards(env: ReturnType<typeof setup>): void {
  env.trace.records.forEach((r, i) => {
    for (const id of [...(r.parentId === undefined ? [] : [r.parentId]), ...(r.causeIds ?? [])]) {
      const at = env.trace.at(id);
      expect(at, `record ${i} (${op(r) ?? r.kind}) names ${id}`).toBeDefined();
      expect(at as number, `record ${i} (${op(r) ?? r.kind}) names ${id}, which is not before it`).toBeLessThan(i);
    }
  });
}

describe("parent: what happens during an action belongs to its start", () => {
  it("phase changes, the notes of the action and its end name the start record; the start itself has no parent", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 30, yM: 10 }, self(a), 0, 0);
    run(env, a);
    const start = indexOfOp(env, "start");
    expect(start).toBe(0);
    expect(env.trace.records[start]?.parentId).toBeUndefined();
    const during = env.trace.records.filter((r, i) => i > start && r.kind === "action");
    expect(during.length).toBeGreaterThan(2); // phases and the end at least
    for (const r of during) expect(r.parentId, op(r)).toBe(`t#${start}`);
    expect(during.map(op)).toContain("phase");
    expect(during.map(op)).toContain("end");
    expectLinksBackwards(env);
  });

  it("a second action has its own start as the parent of its records, and the first one's end still names the first start", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "hold", { durationS: 0.5 }, self(a), 0, 0);
    run(env, a);
    const firstEnd = indexOfOp(env, "end");
    env.rt.start(a, "hold", { durationS: 0.5 }, self(a), 10, 1);
    const secondStart = env.trace.records.length - 1;
    expect(op(env.trace.records[secondStart] as { payload: unknown })).toBe("start");
    run(env, a, 10);
    expect(env.trace.records[firstEnd]?.parentId).toBe("t#0");
    const secondEnd = indexOfOp(env, "end", firstEnd + 1);
    expect(env.trace.records[secondEnd]?.parentId).toBe(`t#${secondStart}`);
    expectLinksBackwards(env);
  });

  it("a start that is refused has no parent: there is no action", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    expect(env.rt.start(a, "goTo", { xM: 150, yM: 10 }, self(a), 0, 0).ok).toBe(false);
    expect(env.trace.records).toHaveLength(1);
    expect(env.trace.records[0]?.parentId).toBeUndefined();
    expect(env.rt.takeRejectedRecord(a.id)).toBe("t#0");
    expect(env.rt.takeRejectedRecord(a.id)).toBeUndefined(); // once
  });
});

describe("cause: the record that made it happen", () => {
  it("a decision is the cause of the start (or of the refusal) it asked for", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "hold", {}, self(a), 0, 0, "decision-record");
    expect(env.trace.records[0]?.causeIds).toEqual(["decision-record"]);
    expect(env.rt.start(a, "goTo", { xM: 150, yM: 10 }, self(a), 0, 0, "another-decision").ok).toBe(false);
    expect(env.trace.records[1]?.causeIds).toEqual(["another-decision"]);
  });

  it("a reflex belongs to the action it acts on, ends that action (the end names the reflex as its cause) and starts the recovery (which names it too)", () => {
    const env = setup();
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 }); // not on the agent's map
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(env, a);
    const reflex = env.trace.records.findIndex((r) => r.kind === "reflex");
    expect(reflex).toBeGreaterThan(0);
    expect(env.trace.records[reflex]?.parentId).toBe("t#0");
    expect(env.trace.records[reflex]?.causeIds).toBeUndefined(); // the trigger is the sensor reading the reflex was given, which is no record of the trace
    const end = indexOfOp(env, "end");
    expect(env.trace.records[end]).toMatchObject({ parentId: "t#0", causeIds: [`t#${reflex}`] });
    expect((env.trace.records[end]?.payload as { status: string }).status).toBe("preempted");
    expectLinksBackwards(env);
  });

  it("a collision is a record of its own action, and the failure that follows names it", () => {
    const env = setup();
    env.spatial.add({ x0: 25, y0: 0, x1: 26, y1: 100 });
    const a = makeUgv(10, 10, 0);
    env.proximity.dropped.add(a.id); // no reflex: the body hits the wall
    env.rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    run(env, a);
    const collision = env.trace.records.findIndex((r) => r.kind === "event" && op(r) === "collision");
    expect(collision).toBeGreaterThan(0);
    expect(env.trace.records[collision]?.parentId).toBe("t#0");
    const end = indexOfOp(env, "end");
    expect(env.trace.records[end]).toMatchObject({ parentId: "t#0", causeIds: [`t#${collision}`] });
    expect((env.trace.records[end]?.payload as { failure: { code: string } }).failure.code).toBe("collision");
    expectLinksBackwards(env);
  });

  it("a goTo that planning ended names the planner's record of the outcome as the cause of its failure", () => {
    const spatial = new FakeSpatial();
    class CausedPlanner extends FakePlanner {
      override take(agentId: string, queryId: string): PlanResult | undefined {
        const r = super.take(agentId, queryId);
        return r === undefined ? undefined : { ...r, causeRecord: "planner-record" };
      }
    }
    const planner = new CausedPlanner(new FakeSpatial());
    planner.status = "not_found";
    const trace = new CollectingTrace();
    const proximity = new FakeProximity(spatial, 2);
    const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, reflexes: defaultReflexes(), proximity, contact: new FakeContact() }, DT);
    const a = makeUgv(10, 10, 0);
    rt.start(a, "goTo", { xM: 40, yM: 10 }, self(a), 0, 0);
    for (let t = 0; t < 200 && rt.isRunning(a.id); t++) {
      planner.advance(t);
      rt.tick(a, t, t * DT);
    }
    const end = trace.records.find((r) => op(r) === "end");
    expect((end?.payload as { failure: { code: string } }).failure.code).toBe("unreachable");
    expect(end).toMatchObject({ parentId: "t#0", causeIds: ["planner-record"] });
  });

  it("the world's event about an ended action can name its end record: it is on the ended action", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "hold", { durationS: 0.2 }, self(a), 0, 0);
    run(env, a);
    const end = indexOfOp(env, "end");
    expect(env.rt.takeEnded()).toEqual([expect.objectContaining({ actionId: "act-000001", status: "succeeded", recordId: `t#${end}` })]);
  });

  it("a trusted-code failure with no record to name has no cause: a plain success never has one", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "hold", { durationS: 0.2 }, self(a), 0, 0);
    run(env, a);
    expect(env.trace.records[indexOfOp(env, "end")]?.causeIds).toBeUndefined();
  });
});

describe("a snapshot keeps the parent of what a running action writes", () => {
  it("a restored runtime links the records that follow to the start the action had", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "hold", { durationS: 2 }, self(a), 0, 0);
    env.proximity.track(a);
    for (let t = 0; t < 5; t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    const snap = env.rt.snapshot();
    expect(snap.active[0]?.startRecord).toBe("t#0");
    const other = setup();
    other.rt.restore(snap, [a]);
    other.proximity.track(a);
    for (let t = 5; t < 400 && other.rt.isRunning(a.id); t++) {
      other.planner.advance(t);
      other.rt.tick(a, t, t * DT);
    }
    const end = other.trace.records.find((r) => op(r) === "end");
    expect(end?.parentId).toBe("t#0");
  });

  it("restored into another run (a derived run continues the sequence under its own ID), the start is named by the id it has there", () => {
    const env = setup();
    const a = makeUgv(10, 10, 0);
    env.rt.start(a, "hold", { durationS: 2 }, self(a), 0, 0);
    env.proximity.track(a);
    for (let t = 0; t < 3; t++) {
      env.planner.advance(t);
      env.rt.tick(a, t, t * DT);
    }
    const snap = env.rt.snapshot();
    class OtherRun extends CollectingTrace {
      override idOf(seq: number): string {
        return `other#${seq}`;
      }
    }
    const spatial = new FakeSpatial();
    const planner = new FakePlanner(new FakeSpatial());
    const trace = new OtherRun();
    const proximity = new FakeProximity(spatial, 2);
    const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, reflexes: defaultReflexes(), proximity, contact: new FakeContact() }, DT);
    rt.restore(snap, [a]);
    proximity.track(a);
    for (let t = 3; t < 400 && rt.isRunning(a.id); t++) {
      planner.advance(t);
      rt.tick(a, t, t * DT);
    }
    expect(trace.records.find((r) => op(r) === "end")?.parentId).toBe("other#0");
  });
});
