import { describe, expect, it } from "vitest";
import type { SimAgent } from "../actions/agent.ts";
import { ActionRuntime, type RuntimeSnapshot } from "../actions/runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUgv } from "../actions/testing/fakes.ts";
import { batteryReflex } from "../reflexes/builtin.ts";
import { decodeValue, encodeValue } from "../snapshot/codec.ts";
import { StateHasher } from "../numerics/state-hash.ts";
import { ScriptBrain, type DecisionEnvelope, type DecisionRequest, type ScriptStep, type TimerOp } from "./brain.ts";
import { Inbox, type DecisionEvent, type InboxSnapshot } from "./events.ts";
import { World, type WorldSnapshot } from "./world.ts";

// F3a M1, T-004: the world's snapshot and restore (ADR-0035 addition of 2026-10-17, item 8): inboxes with their order,
// request timing, timers, the requests outstanding and their answers, the space summaries already traced, run inputs.

const DT = 0.1;

const detected = (id: string, transitions = 1): DecisionEvent => ({ kind: "detected", entityId: id, entityKind: "target", xM: 1, yM: 2, zM: 0, observedAtS: 1, transitions });
const lost = (id: string): DecisionEvent => ({ kind: "lost", entityId: id, entityKind: "target", lastSeenS: 1, transitions: 1 });

describe("Inbox snapshot and restore", () => {
  it("keeps the entries in arrival order with their tick and seq, so coalescing and delivery order go on as before", () => {
    const fill = (b: Inbox) => {
      b.add(detected("o-2"), 3);
      b.add({ kind: "start" }, 3);
      b.add(detected("o-1"), 4);
      b.add(lost("o-2"), 4); // coalesces with o-2
      b.add({ kind: "frontierExhausted" }, 5);
    };
    const a = new Inbox();
    fill(a);
    const snap = decodeValue(encodeValue(a.snapshot())) as InboxSnapshot;
    const b = new Inbox();
    b.restore(snap);
    expect(encodeValue(b.snapshot())).toEqual(encodeValue(a.snapshot()));
    // The same later arrivals: same coalescing (seq continues), same delivery order, same hash.
    for (const x of [a, b]) {
      x.add(detected("o-1", 2), 6);
      x.add({ kind: "frontierExhausted" }, 6); // refused: already there
      x.add(detected("o-3"), 6);
    }
    expect(b.preview()).toEqual(a.preview());
    const ha = new StateHasher();
    const hb = new StateHasher();
    a.hashInto(ha, "ugv-001");
    b.hashInto(hb, "ugv-001");
    expect(hb.hex()).toBe(ha.hex());
    expect(b.take()).toEqual(a.take());
  });

  it("restores an empty inbox over a full one", () => {
    const a = new Inbox();
    const full = new Inbox();
    full.add({ kind: "start" }, 1);
    full.restore(a.snapshot());
    expect(full.size).toBe(0);
    expect(full.snapshot()).toEqual({ entries: [], seq: 0 });
  });
});

describe("ScriptBrain restore path", () => {
  const steps: ScriptStep[] = [{ name: "hold", params: {} }, { name: "hold", params: { durationS: 1 } }];
  const req = (kind: DecisionEvent["kind"]): DecisionRequest => ({ events: [kind === "start" ? { kind: "start" } : { kind: "actionCompleted", actionId: "a", name: "hold", result: {} }] }) as unknown as DecisionRequest;

  it("puts the position back, so the next answer is the one the original would give", async () => {
    const a = new ScriptBrain("s", steps);
    await a.decide(req("start"));
    expect(a.position).toBe(1);
    const b = new ScriptBrain("s", steps);
    b.restorePosition(a.position);
    expect(await b.decide(req("actionCompleted"))).toEqual(await a.decide(req("actionCompleted")));
    expect(() => b.restorePosition(3)).toThrow(/position 3 of 2 steps/);
    expect(() => b.restorePosition(-1)).toThrow(/position -1/);
  });
});

/** The script's brain, plus timers as a pure function of the request: its only state is the script position. */
class TimedBrain extends ScriptBrain {
  override async decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    const env = await super.decide(req);
    const timers: TimerOp[] = [];
    for (const e of req.events) {
      if (e.kind === "start") timers.push({ op: "set", tag: "tick", delayS: 0.7 }, { op: "set", tag: "long", delayS: 30 });
      else if (e.kind === "timer" && e.tag === "tick") timers.push({ op: "set", tag: "tick", delayS: 0.7 });
    }
    return timers.length > 0 ? { ...env, timers } : env;
  }
}

const SCRIPT: ScriptStep[] = [{ name: "goTo", params: { xM: 40, yM: 10 } }, { name: "hold", params: { durationS: 2 } }, { name: "goTo", params: { xM: 15, yM: 30 } }];

interface Rig {
  readonly agent: SimAgent;
  readonly spatial: FakeSpatial;
  readonly planner: FakePlanner;
  readonly trace: CollectingTrace;
  readonly runtime: ActionRuntime;
  readonly brain: TimedBrain;
  world: World;
  tick: number;
}

const worldOf = (r: Pick<Rig, "agent" | "runtime" | "planner" | "trace" | "brain">, genesis: boolean): World =>
  new World({ agents: [r.agent], runtime: r.runtime, planner: r.planner, trace: r.trace, brains: new Map([[r.agent.id, r.brain]]), sensing: { sense: () => {}, takeEvents: () => [] }, genesis });

function build(): Rig {
  const agent = makeUgv();
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const trace = new CollectingTrace();
  const runtime = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, reflexes: [batteryReflex()] }, DT);
  const brain = new TimedBrain("script", SCRIPT);
  const parts = { agent, runtime, planner, trace, brain };
  return { agent, spatial, planner, trace, runtime, brain, world: worldOf(parts, true), tick: 0 };
}

async function step(r: Rig): Promise<void> {
  if (r.world.outstandingCount > 0) await r.world.decide();
  r.tick++;
  r.world.step({ tick: r.tick, simTimeS: r.tick * DT, dtS: DT });
}

const run = async (r: Rig, n: number) => {
  for (let i = 0; i < n; i++) await step(r);
};

const pendingOf = (r: Rig) => JSON.stringify({ outstanding: r.world.outstanding, peek: r.world.peekRequest(r.agent.id) });

/** Restores the snapshots of `a` into a world built without genesis over a twin's ports, with a new runtime and brain. */
async function restoreTwin(a: Rig, n: number): Promise<{ b: Rig; world: WorldSnapshot; runtime: RuntimeSnapshot }> {
  const world = decodeValue(encodeValue(a.world.snapshot())) as WorldSnapshot;
  const runtime = decodeValue(encodeValue(a.runtime.snapshot())) as RuntimeSnapshot;
  const twin = build();
  await run(twin, n); // the fakes keep state too: the twin brings them to tick n
  const freshRuntime = new ActionRuntime({ planner: twin.planner, spatial: twin.spatial, capabilities: fakeCapabilities, trace: twin.trace, reflexes: [batteryReflex()] }, DT);
  freshRuntime.restore(runtime, [twin.agent]);
  const brain = new TimedBrain("script", SCRIPT);
  brain.restorePosition(a.brain.position);
  const parts = { agent: twin.agent, runtime: freshRuntime, planner: twin.planner, trace: twin.trace, brain };
  const b: Rig = { ...twin, runtime: freshRuntime, brain, world: worldOf(parts, false), tick: n };
  b.world.restore(world);
  return { b, world, runtime };
}

describe("World snapshot and restore (F3a M1, T-004)", () => {
  it("genesis false builds a world with no start events, no first requests and no trace records", () => {
    const a = build();
    expect(a.world.outstandingCount).toBe(1);
    expect(a.trace.records.length).toBeGreaterThan(0);
    const t = build();
    const quiet = worldOf(t, false);
    t.trace.records.length = 0;
    expect(quiet.outstandingCount).toBe(0);
    expect(t.trace.records).toEqual([]);
    expect(quiet.peekRequest(t.agent.id)?.request.events).toEqual([]);
  });

  /** The first tick at which the world has a request outstanding and a timer set, after the first action has started. */
  async function busyTick(): Promise<number> {
    const r = build();
    for (let t = 1; t < 400; t++) {
      await step(r);
      if (r.world.outstandingCount > 0 && r.world.snapshot().timers[0]?.length === 2 && t > 20) return t;
    }
    throw new Error("never busy");
  }

  for (const [label, pick] of [
    ["at tick 0, with the first request outstanding", async () => 0],
    ["mid-action, with timers active", async () => 25],
    ["with a decision outstanding and timers active", busyTick],
    ["late, after the script has moved on", async () => 150],
  ] as const) {
    it(`continues exactly as the uninterrupted world ${label}`, async () => {
      const n = await pick();
      const a = build();
      await run(a, n);
      const { b, world } = await restoreTwin(a, n);
      expect(encodeValue(b.world.snapshot()), "snapshot(restore(snapshot)) is byte-identical").toEqual(encodeValue(a.world.snapshot()));
      expect(b.world.stateHash).toBe(a.world.stateHash);
      expect(pendingOf(b)).toBe(pendingOf(a));
      expect(world.tick).toBe(n);
      const traceA = a.trace.records.length;
      const traceB = b.trace.records.length;
      for (let i = 0; i < 120; i++) {
        await step(a);
        await step(b);
        expect(b.world.stateHash, `state hash at tick ${a.tick}`).toBe(a.world.stateHash);
      }
      expect(JSON.stringify(b.trace.records.slice(traceB))).toBe(JSON.stringify(a.trace.records.slice(traceA)));
      expect(pendingOf(b)).toBe(pendingOf(a));
      expect(encodeValue(b.world.snapshot())).toEqual(encodeValue(a.world.snapshot()));
      expect(encodeValue(b.runtime.snapshot())).toEqual(encodeValue(a.runtime.snapshot()));
    }, 60_000);
  }

  it("the snapshot holds what the hash does not: the outstanding request, the traced space summaries, the timers and run inputs", async () => {
    const a = build();
    await run(a, await busyTick());
    const n = a.tick;
    a.world.inject({ agentId: a.agent.id, name: "hold", params: {} }, n + 10);
    const s = a.world.snapshot();
    expect(s.slots[0]?.request.agentId).toBe(a.agent.id);
    expect(s.seenSpaces.length).toBeGreaterThan(0);
    expect(s.timers[0]?.map(([tag]) => tag)).toEqual(["long", "tick"]);
    expect(s.inputLog).toHaveLength(1);
    expect(s.nextInput).toBe(2);
    expect(s.lastRequestS[0]).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(s.prevSoc[0])).toBe(false);
    // A run input recorded before the snapshot is applied in the restored world too.
    const { b } = await restoreTwin(a, n);
    expect(b.world.inputs).toEqual(a.world.inputs);
  });

  it("encodes -Infinity (no request yet) and carries it through the codec", () => {
    const quiet = worldOf(build(), false);
    const s = quiet.snapshot();
    expect(s.lastRequestS).toEqual([Number.NEGATIVE_INFINITY]);
    expect((decodeValue(encodeValue(s)) as WorldSnapshot).lastRequestS).toEqual([Number.NEGATIVE_INFINITY]);
  });

  it("refuses to snapshot a world that failed midway", async () => {
    const r = build();
    await run(r, 3);
    r.planner.advance = () => {
      throw new Error("planner exploded");
    };
    await expect(step(r)).rejects.toThrow(/planner exploded/);
    expect(() => r.world.snapshot()).toThrow(/failed in an earlier step/);
  });

  it("refuses a snapshot that does not agree with the restored parts, or that belongs to other agents", async () => {
    const a = build();
    await run(a, 20);
    const s = a.world.snapshot();
    const quiet = () => worldOf(build(), false);
    expect(() => quiet().restore({ ...s, checkHash: "00000000" })).toThrow(/differs from the snapshot.s/);
    expect(() => quiet().restore({ ...s, agents: [{ ...(s.agents[0] as WorldSnapshot["agents"][number]), id: "ugv-009" }] })).toThrow(/snapshot agent 0 is ugv-009/);
    expect(() => quiet().restore({ ...s, inboxes: [] })).toThrow(/snapshot is for 1 agents, the world has 1/);
  });
});
