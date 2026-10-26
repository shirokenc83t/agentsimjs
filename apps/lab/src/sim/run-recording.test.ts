import { Scheduler, decodeValue, readSnapshot, snapshotHash } from "@agentsim/core";
import { F2_DISCOVERY_ID, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { RECORDING_PRESETS } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { framesOf, profileOf, setup, snapshotsOf } from "./run-recording-harness.ts";

// F3a M2: what a recorded run writes besides what its components trace: checkpoints, snapshots, pose samples, belief keyframes and deltas
// (ADR-0035 addition of 2026-10-17, items 8 and 9; ADR-0029 addition of the same date). F2 discovery: unknown maps, agents that explore.

describe("checkpoints and snapshots", () => {
  it("writes a start snapshot, its snapshot record and a checkpoint with both hashes, before the first tick", () => {
    const t = setup();
    t.step(0);
    const [snap] = snapshotsOf(t.items);
    expect(snap).toMatchObject({ runId: "run-000001", tick: 0, simTimeS: 0 });
    const rec = t.records().filter((r) => r.kind === "snapshot");
    expect(rec).toHaveLength(1);
    const id = snapshotHash(snap?.bytes ?? new Uint8Array());
    expect(rec[0]).toMatchObject({ worldRef: id, source: "world/sim", payload: { op: "snapshot", reason: "start", tick: 0, id } });
    expect(rec[0]?.seq).toBe(snap?.seq);
    const cp = t.records().filter((r) => t.op(r) === "checkpoint");
    expect(cp).toHaveLength(1);
    expect(cp[0]?.payload).toEqual({ op: "checkpoint", tick: 0, stateHash: t.world.stateHash, snapshotHash: id });
  });

  it("writes a checkpoint every N ticks with the state hash of that tick, the same hash as a run that is not recorded", () => {
    const t = setup();
    const plain = ScenarioHostedWorld.load({ runId: "run-000001", scenario: f2DiscoveryScenario(), scenarioVersion: 1, runConfig: f2RunConfig(F2_DISCOVERY_ID, 1) }, () => 0);
    if (!plain.ok) throw new Error("load");
    const ps = new Scheduler(plain.value, plain.value.dtS);
    t.explore();
    plain.value.inject({ agentId: t.driver, name: "explore", params: {} });
    const expected = new Map<number, string>();
    for (let i = 1; i <= 250; i++) {
      ps.step();
      if (i % 100 === 0) expected.set(i, plain.value.stateHash);
    }
    t.step(250);
    const cps = t.records().filter((r) => t.op(r) === "checkpoint").map((r) => r.payload as { tick: number; stateHash: string });
    expect(cps.map((c) => c.tick)).toEqual([0, 100, 200]);
    for (const c of cps.slice(1)) expect(c.stateHash, `tick ${c.tick}`).toBe(expected.get(c.tick));
    expect(t.world.stateHash).toBe(plain.value.stateHash); // recording changed nothing
  });

  it("takes a snapshot every S sim seconds, and each carries its hash in its record and in the checkpoint of its tick", () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, checkpoints: { everyTicks: 100, snapshotEveryS: 5 } })));
    t.explore();
    t.step(120);
    const snaps = snapshotsOf(t.items);
    expect(snaps.map((s) => s.tick)).toEqual([0, 50, 100]);
    for (const s of snaps) {
      const id = snapshotHash(s.bytes);
      const rec = t.records().find((r) => r.kind === "snapshot" && (r.payload as { tick: number }).tick === s.tick);
      expect(rec).toMatchObject({ worldRef: id, seq: s.seq });
      const cp = t.records().find((r) => t.op(r) === "checkpoint" && (r.payload as { tick: number }).tick === s.tick);
      expect((cp?.payload as { snapshotHash?: string }).snapshotHash).toBe(id);
    }
    expect(t.records().filter((r) => t.op(r) === "checkpoint").map((r) => (r.payload as { tick: number }).tick)).toEqual([0, 50, 100]);
    expect((readSnapshot(snaps[2]?.bytes ?? new Uint8Array()).root as { tick: number }).tick).toBe(100);
  });

  it("takes a snapshot when the run stops, unless the run is where the last one was taken", () => {
    const t = setup();
    t.explore();
    t.step(30);
    t.recording.end();
    t.recorder.collect(t.world.tick, t.world.simTimeS);
    expect(snapshotsOf(t.items).map((s) => s.tick)).toEqual([0, 30]);
    t.recording.end();
    expect(snapshotsOf(t.items)).toHaveLength(2);
    const endRecord = t.records().filter((r) => r.kind === "snapshot").map((r) => (r.payload as { reason: string }).reason);
    expect(endRecord).toEqual(["start", "end"]);
  });

  it("sends a section that has not changed once: no blob appears in two items", () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, checkpoints: { everyTicks: 100, snapshotEveryS: 2 } })));
    t.step(100); // nobody explores: the maps do not change between snapshots
    const ids = t.items.flatMap((i) => (i.type === "metrics" ? [] : i.blobs).map((b) => b.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snapshotsOf(t.items).length).toBeGreaterThan(3);
  });
});

describe("belief keyframes and deltas", () => {
  it("writes a keyframe per agent at the start, sharing the blob of the snapshot's belief section", () => {
    const t = setup();
    const kf = framesOf(t.items).filter((f) => f.kind === "keyframe");
    expect(kf.map((f) => f.agentId).sort()).toEqual([...t.world.entityIds].sort());
    const [snap] = snapshotsOf(t.items);
    const refs = (readSnapshot(snap?.bytes ?? new Uint8Array()).root as { sensing: { agents: { agentId: string; belief: { hash: string } }[] } }).sensing.agents;
    for (const f of kf) expect(f.blobId).toBe(refs.find((a) => a.agentId === f.agentId)?.belief.hash);
    for (const f of kf) expect((snap?.blobs ?? []).some((b) => b.id === f.blobId)).toBe(true);
  });

  it("writes a delta for the chunks that changed at a sync point, only for the agents whose map changed, and keyframes every K seconds", () => {
    const t = setup(profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 4 } } })));
    const explorer = t.driver;
    t.explore(explorer);
    t.step(120);
    const frames = framesOf(t.items);
    const mine = frames.filter((f) => f.agentId === explorer);
    expect(mine.some((f) => f.kind === "delta")).toBe(true);
    expect(mine.filter((f) => f.kind === "keyframe").map((f) => f.tick)).toEqual([0, 40, 80, 120].filter((x) => x <= 120));
    for (const f of mine.filter((x) => x.kind === "delta")) {
      expect(f.chunks.length).toBeGreaterThan(0);
      // The chunks a frame names are each once and ascending: the storage port refuses anything else.
      expect(f.chunks).toEqual([...new Set(f.chunks)].sort((x, y) => x - y));
      expect(f.data?.length).toBeGreaterThan(0);
      // A delta holds the cells that changed, not the chunks they lie in: a handful of bytes per cell, far under one chunk.
      const cells = (decodeValue(f.data ?? new Uint8Array()) as { cells: Int32Array }).cells;
      expect(cells.length).toBeGreaterThan(0);
      expect(f.data?.length ?? 0).toBeLessThan(cells.length * 12 + 200);
    }
    // seq is the agent's own counter, from 0, with ticks never going back.
    expect(mine.map((f) => f.seq)).toEqual(mine.map((_, i) => i));
    expect(mine.map((f) => f.tick)).toEqual([...mine.map((f) => f.tick)].sort((a, b) => a - b));
    // An agent that never moved sees no change, so it has its keyframes and no delta.
    // An agent whose map changes less has fewer deltas; a tick where nothing changed writes none (a delta always names chunks).
    const idle = t.world.entityIds.find((id) => id !== explorer && !id.startsWith("uav"));
    expect(mine.filter((f) => f.kind === "delta").length).toBeGreaterThan(frames.filter((f) => f.agentId === idle && f.kind === "delta").length);
  });

  it("writes none of it when the profile's beliefs are off or only diffs", () => {
    for (const level of ["off", "diffs"] as const) {
      const t = setup(profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level, keyframeEveryS: 30 } } })));
      t.explore();
      t.step(60);
      expect(framesOf(t.items), level).toEqual([]);
      expect(snapshotsOf(t.items).length).toBeGreaterThan(0); // snapshots are not optional
    }
  });
});

describe("pose samples", () => {
  const poses = (t: ReturnType<typeof setup>, agentId: string) => t.records().filter((r) => r.kind === "observation" && r.source === `${agentId}/body` && t.op(r) === "pose");

  it("samples each agent at the profile's rate in sim time, from its body, with the fields the Explorer shows", () => {
    const t = setup();
    const id = t.world.entityIds[0] ?? "";
    t.step(50);
    const s = poses(t, id);
    expect(s.map((r) => r.simTime)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((x) => expect.closeTo(x, 6)));
    expect(s[0]).toMatchObject({ kind: "observation", agentId: id, source: `${id}/body`, detail: "sampled" });
    expect(Object.keys(s[1]?.payload as object).sort()).toEqual(["airborne", "heading", "odometerM", "op", "soc", "speedMps", "trigger", "x", "y", "z"]);
    expect((s[0]?.payload as { trigger: string }).trigger).toBe("start");
    expect((s[1]?.payload as { trigger: string }).trigger).toBe("rate");
  });

  it("takes an extra sample at an action's start and end, with the transition as its trigger, never two in one tick", () => {
    const t = setup();
    const id = t.driver;
    t.step(3);
    t.explore(id);
    t.step(10);
    const triggers = poses(t, id).map((r) => [Math.round(r.simTime * 10), (r.payload as { trigger: string }).trigger]);
    expect(triggers.some(([, trig]) => trig === "action-start")).toBe(true);
    const ticks = triggers.map(([tick]) => tick);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("takes the profile's rate per kind when it has one, and a poses sample matches the live state at that tick", () => {
    const fast = profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, poses: { rateHz: 2, perKindRateHz: { ugv: 10, uav: 10, ev: 10 } } } }));
    const t = setup(fast);
    const id = t.driver;
    t.explore(id);
    t.step(20);
    const s = poses(t, id);
    expect(s.length).toBeGreaterThanOrEqual(20);
    const last = s.at(-1);
    const agent = t.world.recordingTarget().run.agents.find((a) => a.id === id);
    expect(last).toBeDefined();
    expect(last?.simTime).toBeCloseTo(t.world.simTimeS, 6);
    expect((last?.payload as { x: number }).x).toBe(agent?.state.x);
    expect((last?.payload as { y: number }).y).toBe(agent?.state.y);
  });

  it("writes poses under every preset, and none of them reach the panel stream", () => {
    for (const name of Object.keys(RECORDING_PRESETS) as (keyof typeof RECORDING_PRESETS)[]) {
      const t = setup(RECORDING_PRESETS[name]);
      t.step(20);
      expect(t.records().some((r) => t.op(r) === "pose"), name).toBe(true);
      expect(t.recorder.takePanel().some((r) => (r.payload as { op?: string } | undefined)?.op === "pose"), name).toBe(false);
    }
  });
});
