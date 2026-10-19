import { decodeValue, encodeValue, runLockstep, StateHasher, type SimAgent } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildPresetRun, type PresetRunOptions } from "../testing/preset-run.ts";
import type { ReferenceRun } from "../testing/reference-run.ts";
import type { ObserverSnapshot } from "./belief-vs-truth.ts";
import type { SensingSnapshot } from "./sensing.ts";
import type { TopologySnapshot } from "./topology.ts";

// F3a M1: the services behind core's ports restore from their snapshots (ADR-0035 addition of 2026-10-17, item 8).
// Contract per service: snapshot (through the codec), restore into a freshly assembled twin, continue both with the same
// inputs, same outputs. The sensing phase is driven by hand here (a scripted motion of the agents, no world), in the order the
// world's sensing phase runs it: readings, the planner's sync point, the topological layer, the observer.

const DT = 0.1;
const priv = (o: unknown, key: string): unknown => (o as Record<string, unknown>)[key];
const values = (m: unknown): unknown[] => (m instanceof Map ? [...m.values()] : Array.isArray(m) ? m : []);

const OPTIONS: PresetRunOptions = { preset: "f2-discovery", scripts: {}, beliefVsTruth: { everyS: 0.5 } };

/** Where each agent is at tick t: the rover drives east through the wall and back, the others follow their own legs. */
function place(a: SimAgent, t: number): void {
  const s = a.state;
  const phase = t <= 100 ? t : 200 - t;
  if (a.key === "rover") {
    s.x = 10 + 0.45 * phase;
    s.y = 8;
    s.heading = t <= 100 ? 0 : Math.PI;
  } else if (a.key === "low") {
    s.x = 10 + 0.1 * t;
    s.y = 20 + 0.2 * Math.min(t, 150);
    s.heading = 0.4;
  } else if (a.kind === "uav") {
    s.x = 12 + 0.3 * t;
    s.y = 12 + 0.25 * t;
    if ("z" in s) s.z = 20;
    s.heading = 0.7;
  }
}

/** One sensing phase as the world runs it; returns what it produced, as a comparable string. */
function phase(run: ReferenceRun, t: number): string {
  for (const a of run.agents) place(a, t);
  const simTimeS = t * DT;
  run.sensing.sense(t, simTimeS);
  run.planner.syncViews();
  run.topology.update(simTimeS);
  run.observer?.sample(t, simTimeS);
  return JSON.stringify({ events: run.sensing.takeEvents(), exhausted: run.topology.takeExhausted() });
}

/** What the services expose, to compare two runs at the same moment. */
function observe(run: ReferenceRun): string {
  return JSON.stringify({
    beliefs: run.agents.map((a) => run.sensing.beliefHash(a.id)),
    entities: run.agents.map((a) => [...run.sensing.entities(a.id)]),
    hits: run.agents.map((a) => run.sensing.hits(a.id)),
    rng: values(priv(run.sensing, "byId")).map((s) => values(priv(s, "sensors")).map((st) => [priv(priv(st, "rng"), "s"), priv(priv(st, "rng"), "spareNormal"), priv(st, "dropped")])),
    candidates: run.agents.map((a) => run.topology.candidates(a.id)),
    marked: run.agents.map((a) => run.topology.markedCount(a.id)),
    regions: run.agents.map((a) => run.topology.of(a.id).regions().map((r) => [r.id, r.known, r.free, r.occupied])),
  });
}

const observerRecords = (run: ReferenceRun) => JSON.stringify(run.trace.all().filter((r) => (r.payload as { op?: string }).op === "belief-vs-truth").map((r) => ({ ...r, wallTime: 0 })));
/** The belief and sensor records written since `from`, without their ids (the trace cursor has its own test). */
const eventRecords = (run: ReferenceRun, from: number) =>
  JSON.stringify(
    run.trace
      .all()
      .filter((r) => r.seq >= from && (r.source.endsWith("/beliefs") || r.source.endsWith("/sensors")))
      .map((r) => ({ source: r.source, simTime: r.simTime, kind: r.kind, agentId: r.agentId, detail: r.detail, payload: r.payload })),
  );

function copyAgents(from: ReferenceRun, to: ReferenceRun): void {
  from.agents.forEach((a, i) => {
    const b = to.agents[i];
    if (!b) throw new Error("agent");
    Object.assign(b.state, a.state);
  });
}

interface Taken {
  readonly sensing: SensingSnapshot;
  readonly topology: TopologySnapshot;
  readonly observer: ObserverSnapshot;
}

function takeSnapshots(run: ReferenceRun): Taken {
  const s = run.sensing.snapshot();
  const t = run.topology.snapshot();
  const o = run.observer?.snapshot();
  if (!o) throw new Error("observer");
  return decodeValue(encodeValue({ sensing: s, topology: t, observer: o })) as Taken;
}

/** Runs A to `n` (marking one frontier of the rover on the way), restores B from A's snapshot, continues both for `after` ticks. */
function check(n: number, after: number, markAt?: number, temporaryAt?: number) {
  const a = buildPresetRun(OPTIONS);
  for (let t = 1; t <= n; t++) {
    phase(a, t);
    if (t === markAt) {
      const rover = a.agents.find((x) => x.key === "rover");
      const c = rover ? a.topology.candidates(rover.id)[0] : undefined;
      if (!rover || !c) throw new Error("no frontier to mark");
      expect(a.topology.markAt(rover.id, c.xM, c.yM, t * DT)).toBe(true);
    }
    if (t === temporaryAt) {
      const rover = a.agents.find((x) => x.key === "rover");
      const c = rover ? a.topology.candidates(rover.id)[0] : undefined;
      if (!rover || !c) throw new Error("no frontier to mark");
      expect(a.topology.markTemporaryAt(rover.id, c.xM, c.yM, t * DT)).toBe(true);
    }
  }
  const taken = takeSnapshots(a);
  const b = buildPresetRun(OPTIONS);
  copyAgents(a, b);
  b.sensing.restore(taken.sensing);
  b.topology.restore(taken.topology);
  b.observer?.restore(taken.observer);
  expect(observe(b), "right after the restore").toBe(observe(a));
  const markedAtRestore = b.agents.map((x) => b.topology.markedCount(x.id));
  expect(JSON.stringify(b.sensing.snapshot())).toBe(JSON.stringify(a.sensing.snapshot()));
  expect(JSON.stringify(b.topology.snapshot())).toBe(JSON.stringify(a.topology.snapshot()));
  const seqA = a.trace.all().length;
  const seqB = b.trace.all().length;
  for (let t = n + 1; t <= n + after; t++) {
    const outA = phase(a, t);
    const outB = phase(b, t);
    expect(outB, `events of tick ${t}`).toBe(outA);
    expect(observe(b), `services at tick ${t}`).toBe(observe(a));
  }
  expect(eventRecords(b, seqB)).toBe(eventRecords(a, seqA));
  expect(encodeValue(b.sensing.snapshot())).toEqual(encodeValue(a.sensing.snapshot()));
  expect(encodeValue(b.topology.snapshot())).toEqual(encodeValue(a.topology.snapshot()));
  return { a, b, taken, seqA, seqB, markedAtRestore };
}

describe("sensing, topology and the observer restore from their snapshots (F3a M1)", () => {
  it("before anything has been seen (empty maps, no entities)", () => {
    const { taken } = check(3, 60);
    expect(taken.sensing.agents.every((x) => x.entities.length === 0)).toBe(true);
  }, 120_000);

  it("with the maps filling and the camera seeing and losing the marker: entity beliefs in order, `lost` flags, RNG streams", () => {
    for (const n of [45, 70, 130]) {
      const { taken } = check(n, 90);
      expect(taken.sensing.agents.some((x) => x.belief.chunks.length > 0)).toBe(true);
    }
  }, 240_000);

  it("with entities detected and lost: the marker is in some agent's beliefs, and `lost` has been set", () => {
    const { taken } = check(150, 40);
    const entities = taken.sensing.agents.flatMap((x) => x.entities);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.some(([, e]) => e.lost)).toBe(true);
  }, 240_000);

  it("with unreachable marks: the marked cells come back and are re-based on the rebuilt view", () => {
    const { taken, markedAtRestore } = check(40, 80, 40);
    const rover = taken.topology.agents.find((x) => x.marks && x.marks.cells.length > 0);
    expect(rover?.marks?.cells.length).toBeGreaterThan(0);
    expect(markedAtRestore.some((n) => n > 0)).toBe(true); // marked groups right after the restore (later the view changes and clears them, in both runs)
  }, 240_000);

  it("with temporary marks (ADR-0040): they come back flagged on the candidates, and clear with the explore iteration or a change around them", () => {
    const { a, b, taken } = check(40, 80, undefined, 40);
    const rover = taken.topology.agents.find((x) => x.temporary && x.temporary.cells.length > 0);
    expect(rover?.temporary?.cells.length).toBeGreaterThan(0);
    // A temporary mark is not a permanent one: the group is still an unmarked candidate, flagged.
    expect(taken.topology.agents.every((x) => !x.marks || x.marks.cells.length === 0)).toBe(true);
    for (const run of [a, b]) {
      const r = run.agents.find((x) => x.key === "rover");
      if (!r) throw new Error("rover");
      run.topology.clearTemporary(r.id, 0);
      expect(run.topology.candidates(r.id).some((c) => c.temporary)).toBe(false);
    }
  }, 240_000);

  it("a mark for good replaces the temporary one; temporary marks enter the state hash only while they exist", () => {
    const a = buildPresetRun(OPTIONS);
    for (let t = 1; t <= 40; t++) phase(a, t);
    const rover = a.agents.find((x) => x.key === "rover");
    const c = rover ? a.topology.candidates(rover.id)[0] : undefined;
    if (!rover || !c) throw new Error("no frontier");
    const hashOf = (): number => {
      const h = new StateHasher();
      a.topology.hashInto(h);
      return h.digest();
    };
    const before = hashOf();
    expect(a.topology.markTemporaryAt(rover.id, c.xM, c.yM, 0)).toBe(true);
    const during = hashOf();
    expect(during).not.toBe(before);
    expect(a.topology.candidates(rover.id).find((x) => x.id === c.id)?.temporary).toBe(true);
    expect(a.topology.markAt(rover.id, c.xM, c.yM, 40 * DT)).toBe(true);
    expect(a.topology.snapshot().agents.find((x) => x.agentId === rover.id)?.temporary?.cells ?? []).toEqual([]);
    a.topology.clearTemporary(rover.id, 0);
    expect(a.topology.candidates(rover.id).every((x) => !x.temporary)).toBe(true);
  }, 240_000);

  it("the observer's sample schedule comes back: its trace records appear at the same ticks as the original's", () => {
    const { a, b, taken, seqA, seqB } = check(55, 60);
    expect(taken.observer.dueS.some((d) => d > 0)).toBe(true);
    const after = (r: ReferenceRun, from: number) => JSON.stringify(r.trace.all().filter((x) => x.seq >= from && (x.payload as { op?: string }).op === "belief-vs-truth").map((x) => ({ source: x.source, simTime: x.simTime, payload: x.payload })));
    expect(after(b, seqB)).toBe(after(a, seqA));
    expect(observerRecords(a).length).toBeGreaterThan(2);
  }, 240_000);

  it("refuses snapshots that do not fit the run, and perception events not yet taken", () => {
    const a = buildPresetRun(OPTIONS);
    for (let t = 1; t <= 60; t++) phase(a, t);
    const s = decodeValue(encodeValue(a.sensing.snapshot())) as SensingSnapshot;
    const b = buildPresetRun(OPTIONS);
    expect(() => b.sensing.restore({ ...s, agents: s.agents.slice(1) })).toThrow(/snapshot has 2 agents' sensing, the run has 3/);
    expect(() => b.sensing.restore({ ...s, agents: s.agents.map((x, i) => (i === 0 ? { ...x, agentId: "ugv-009" } : x)) })).toThrow(/unknown agent ugv-009/);
    expect(() => b.sensing.restore({ ...s, agents: s.agents.map((x, i) => (i === 0 ? { ...x, sensors: x.sensors.slice(1) } : x)) })).toThrow(/sensors for/);
    const t = decodeValue(encodeValue(a.topology.snapshot())) as TopologySnapshot;
    expect(() => b.topology.restore({ agents: t.agents.slice(1) })).toThrow(/snapshot has 2 agents' topology/);
    const o = a.observer?.snapshot();
    expect(() => b.observer?.restore({ dueS: [...(o?.dueS ?? []), 1], labels: o?.labels ?? [] })).toThrow(/sample times/);
    // A reading whose events nobody took is not a state a snapshot may hide.
    for (const x of a.agents) place(x, 61);
    a.sensing.sense(61, 6.1);
    if (priv(a.sensing, "pending") instanceof Array && (priv(a.sensing, "pending") as unknown[]).length > 0) expect(() => a.sensing.snapshot()).toThrow(/not yet taken/);
  }, 240_000);
});

describe("planner adapter snapshot (F3a M1)", () => {
  const build = () => buildPresetRun({ preset: "f1-demo", scripts: {} });

  it("keeps the planning configurations that setConfig changed, and only those", () => {
    const a = build();
    expect(a.planner.snapshot().overrides).toEqual([]);
    const rover = a.resolved.agents.find((x) => x.agentId.startsWith("ugv"));
    if (!rover) throw new Error("ugv");
    const changed = { ...rover, planning: { ...rover.planning, onboardComputeExpansionsPerTick: 777 } };
    a.planner.setConfig(changed);
    const snap = decodeValue(encodeValue(a.planner.snapshot())) as ReturnType<typeof a.planner.snapshot>;
    expect(snap.overrides.map(([id]) => id)).toEqual([rover.agentId]);
    const b = build();
    b.planner.restore(snap);
    expect(encodeValue(b.planner.snapshot())).toEqual(encodeValue(a.planner.snapshot()));
    expect(b.planner.snapshot().overrides[0]?.[1].planning.onboardComputeExpansionsPerTick).toBe(777);
    expect(() => b.planner.restore({ ...snap, overrides: [["ugv-099", changed]] })).toThrow(/unknown agent ugv-099/);
  });

  it("refuses while outcomes, restarts or lazy legs are waiting to be taken: they are handed over within the tick", () => {
    const a = build();
    const rover = a.agents.find((x) => x.kind === "ugv");
    if (!rover) throw new Error("ugv");
    const q = a.planner.submit(rover.id, { from: { x: rover.state.x, y: rover.state.y }, to: { x: 20, y: 12 } }, 1);
    expect(q.ok).toBe(true);
    for (let t = 1; t < 400 && a.planner.service.isPlanning(rover.id); t++) a.planner.service.tick(t); // the service finished; the adapter has not taken it
    expect(a.planner.service.pendingOutputs().completed).toBe(1);
    expect(() => a.planner.snapshot()).toThrow(/outputs not yet taken \(1 outcomes/);
    a.planner.advance(400);
    expect(() => a.planner.snapshot()).toThrow(/outputs not yet taken \(1 outcomes/); // now in the adapter, for the runtime
    if (!q.ok) throw new Error("submit");
    expect(a.planner.take(rover.id, q.value)?.status).toBe("found");
    expect(a.planner.snapshot().service.active).toEqual([]);
  });

  it("asks the planning view of a UAV at the altitude its path is planned at (the map of a restored goTo)", () => {
    const a = build();
    const uav = a.agents.find((x) => x.kind === "uav");
    if (!uav) throw new Error("uav");
    const low = a.planner.liveView(uav.id, 5);
    const high = a.planner.liveView(uav.id, 40);
    const dflt = a.planner.liveView(uav.id);
    expect(low).toBeDefined();
    expect(low).not.toBe(high);
    expect(a.planner.liveView(uav.id, 5)).toBe(low); // the same live view each time
    expect(dflt).toBe(a.planner.liveView(uav.id, (uav.body as { cruiseAltitudeM: number }).cruiseAltitudeM));
    expect(a.planner.currentMap(uav.id, 5).version).toBe(low?.version);
  });
});

describe("the planner has nothing waiting between ticks of a real run (asserted, not captured)", () => {
  const lazyDoc = { schemaVersion: 0, id: "lazy-restore", version: 1, root: { kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } };
  const planning = (strategy: unknown) => ({ planning: { default: { strategy, onboardComputeExpansionsPerTick: 100 } } }) as never;
  const far = { rover: [{ name: "goTo", params: { xM: 50, yM: 40 } }], low: [{ name: "goTo", params: { xM: 25, yM: 60 } }] };

  it.each([
    ["lazy goTo, unknown map", { preset: "f2-discovery", scripts: far, runConfig: planning(lazyDoc) }],
    ["explore, unknown map", { preset: "f2-discovery", scripts: { rover: [{ name: "explore", params: {} }], low: far.low } }],
    ["plain goTo, ideal beliefs", { preset: "f1-demo", scripts: far }],
  ] as const)("%s: the adapter's snapshot never finds an output waiting", async (_name, o) => {
    const run = buildPresetRun(o as PresetRunOptions);
    for (let t = 1; t <= 700; t++) {
      await runLockstep(run.world, run.scheduler, 1);
      expect(() => run.planner.snapshot(), `tick ${t}`).not.toThrow();
    }
  }, 240_000);
});
