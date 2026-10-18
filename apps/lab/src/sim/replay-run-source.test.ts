import { cursorPort, f2DiscoveryScenario, latestPlansOfRecords, recorded, replayOver } from "./replay-test-support.ts";
import { createMemoryPorts, type StoragePorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { ChunkQueue } from "@agentsim/ui";
import { describe, expect, it } from "vitest";
import { beliefAt, resetReplayCache } from "../workers/replay-module.ts";
import { isJump, openReplaySource, type ReplayRunSource } from "./replay-run-source.ts";

// F3a M3: a recorded run replayed from storage alone: the entity table, poses at sampled ticks equal to the live run's, between them interpolated, executed
// trails, records at the cursor, belief overlay bytes, and the ways it refuses. The source holds no sim client: nothing here can reach the sim worker.

async function open(ports: StoragePorts, cursor: ReturnType<typeof cursorPort>): Promise<ReplayRunSource> {
  const r = await openReplaySource({ runId: "run-000001", ports, replay: replayOver(ports), cursor: cursor.port, refreshMs: 0 });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

const poseAt = (src: ReplayRunSource, i: number) => {
  const out = src.poses.sample(0);
  return { x: out[i * 4], y: out[i * 4 + 1], z: out[i * 4 + 2], heading: out[i * 4 + 3] };
};

describe("isJump", () => {
  const s = (t: number, x: number, speed = 1): Parameters<typeof isJump>[0] => ({ t, x, y: 0, z: 0, heading: 0, speed, soc: 1, odometerM: 0, airborne: false });
  it("is a displacement no body could have made in the time between the samples", () => {
    expect(isJump(s(0, 0), s(0.1, 0.1))).toBe(false);
    expect(isJump(s(0, 0, 5), s(1, 5, 5))).toBe(false); // moving at its speed
    expect(isJump(s(0, 0), s(0.1, 50))).toBe(true);
    expect(isJump(s(0, 0, 0), s(2, 30, 0))).toBe(true); // stationary samples that are 30 m apart
  });
});

describe("a recorded run replayed from storage", () => {
  it("has the live run's entities, grid and a pose rate to tell, and says where the recording ends", async () => {
    const { t, ports } = await recorded(100);
    const c = cursorPort();
    const src = await open(ports, c);
    expect(src.entityIds).toEqual(t.world.entityIds);
    expect(src.run.agents.map((a) => a.kind)).toEqual(t.world.entityIds.map((id) => (id.startsWith("uav") ? "uav" : "ugv")));
    const g = t.world.gridMessage();
    expect([src.grid.dims.sizeX, src.grid.dims.sizeY, src.grid.dims.chunkSize]).toEqual([g.sizeX, g.sizeY, g.chunkSize]);
    expect(src.run.dtS).toBeCloseTo(0.1, 9);
    expect(src.poseRate).toContain("10 Hz");
    expect(src.headSeconds).toBeCloseTo(10, 6);
    expect(src.snapshot()).toMatchObject({ mode: "replay", runId: "run-000001", simHeadTick: 100 });
    expect(src.unavailable("rays")).toMatch(/not recorded/);
    expect(src.unavailable("commands")).toBeDefined();
    src.dispose();
    expect(c.count()).toBe(0);
  });

  it("shows poses equal to the live state at every sampled tick, and the midway pose between two samples", async () => {
    const { ports, live, t } = await recorded(100);
    const c = cursorPort();
    const src = await open(ports, c);
    const ids = t.world.entityIds;
    for (const tick of [0, 1, 17, 50, 99, 100]) {
      c.set(tick * 0.1);
      await src.settled();
      ids.forEach((id, i) => {
        const want = live.at.get(tick)?.get(id);
        const got = poseAt(src, i);
        expect([got.x, got.y, got.z, got.heading].map((v) => Math.fround(v ?? 0)), `${id} at tick ${tick}`).toEqual([want?.x, want?.y, want?.z, want?.heading].map((v) => Math.fround(v ?? 0)));
      });
    }
    // Between two samples the pose is the blend of the two.
    c.set(50.5 * 0.1);
    await src.settled();
    ids.forEach((id, i) => {
      const a = live.at.get(50)?.get(id);
      const b = live.at.get(51)?.get(id);
      const got = poseAt(src, i);
      expect(got.x).toBeCloseTo(((a?.x ?? 0) + (b?.x ?? 0)) / 2, 3);
      expect(got.y).toBeCloseTo(((a?.y ?? 0) + (b?.y ?? 0)) / 2, 3);
    });
    // The state at the cursor: battery from the sample.
    expect(src.snapshot().agentStatus?.[0]).toBeCloseTo(live.at.get(50)?.get(ids[0] ?? "")?.soc ?? 0, 5);
    // Without interpolation the pose is the sample at or before the cursor.
    src.poses.setInterpolation(false);
    ids.forEach((id, i) => expect(poseAt(src, i).x).toBeCloseTo(live.at.get(50)?.get(id)?.x ?? 0, 4));
    src.dispose();
  });

  it("snaps across a jump instead of smoothing across it", async () => {
    const { ports, t } = await recorded(60, (records) => {
      // A teleport of the first agent between two samples: from tick 30 on it is 400 m away.
      const id = t0Id(records);
      return records.map((r) => (r.agentId === id && r.kind === "observation" && r.simTime >= 3 - 1e-9 && (r.payload as { op?: string }).op === "pose" ? { ...r, payload: { ...(r.payload as object), x: (r.payload as { x: number }).x + 400 } } : r));
    });
    const c = cursorPort();
    const src = await open(ports, c);
    c.set(2.95);
    await src.settled();
    const before = poseAt(src, 0).x ?? 0;
    c.set(2.99);
    await src.settled();
    expect(poseAt(src, 0).x).toBeCloseTo(before, 0); // held, not moving toward the far sample
    c.set(3.0);
    await src.settled();
    expect(Math.abs((poseAt(src, 0).x ?? 0) - before)).toBeGreaterThan(300);
    expect(t.world.entityIds.length).toBeGreaterThan(0);
    src.dispose();
  });

  it("draws the executed path up to the cursor: it grows with the cursor and shrinks when it goes back", async () => {
    const { ports, live, t } = await recorded(100);
    const c = cursorPort();
    const src = await open(ports, c);
    const id = t.driver;
    c.set(5);
    await src.settled();
    const mid = src.executedPath(id);
    c.set(10);
    await src.settled();
    const end = src.executedPath(id);
    expect(end.count).toBeGreaterThan(mid.count);
    expect(Math.fround(end.points[(end.count - 1) * 3] ?? 0)).toBe(Math.fround(live.at.get(100)?.get(id)?.x ?? 0));
    c.set(2);
    await src.settled();
    const back = src.executedPath(id);
    expect(back.count).toBeLessThan(mid.count);
    expect(back.version).toBeGreaterThan(end.version);
    src.dispose();
  });

  it("holds the records up to the cursor, without pose samples; going back cuts them, going forward reads on", async () => {
    const { ports, t } = await recorded(100);
    const c = cursorPort();
    const src = await open(ports, c);
    c.set(8);
    await src.settled();
    const all = src.records();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.simTime <= 8 + 1e-9)).toBe(true);
    expect(all.some((r) => r.kind === "observation" && r.source.endsWith("/body"))).toBe(false);
    const liveUpTo = (s: number) => t.records().filter((r) => r.simTime <= s + 1e-9 && !r.source.endsWith("/body")).map((r) => r.seq);
    expect(src.records().map((r) => r.seq)).toEqual(liveUpTo(8));
    c.set(3);
    await src.settled();
    expect(src.records().map((r) => r.seq)).toEqual(liveUpTo(3));
    c.set(10);
    await src.settled();
    expect(src.records().map((r) => r.seq)).toEqual(liveUpTo(10));
    // Planned paths are what the live trace's compute records say at the cursor.
    const plans = latestPlansOfRecords(t.records().filter((r) => r.simTime <= 10 + 1e-9));
    expect([...src.plannedPaths()].map(([k, v]) => [k, v.seq])).toEqual([...plans].map(([k, v]) => [k, v.seq]));
    src.dispose();
  });

  it("feeds the belief overlay of the agent at the cursor's tick: the live bytes, nearest groups first, chunks forgotten when the cursor goes back", async () => {
    resetReplayCache();
    const { ports, t } = await recorded(100);
    const id = t.driver;
    const belief = t.world.recordingTarget().run.sensing.belief(id);
    const n = belief.chunkSize ** 2;
    const c = cursorPort();
    const src = await open(ports, c);
    const queue = new ChunkQueue(Math.ceil(src.grid.dims.sizeX / src.grid.dims.chunkSize));
    const chunksX = Math.ceil(src.grid.dims.sizeX / src.grid.dims.chunkSize);
    const take = () => {
      const got = new Map<number, Uint8Array>();
      queue.take(10_000, (ci, cj, data) => got.set(cj * chunksX + ci, data.slice(0, n)));
      return got;
    };
    c.set(10);
    const stop = src.watchBelief("run-000001", id, queue);
    await src.settled();
    await new Promise((r) => setTimeout(r, 100));
    const got = take();
    const live = new Map<number, Uint8Array>();
    for (const k of belief.materializedIndices()) {
      const bytes = new Uint8Array(n);
      belief.classifyChunk(k % chunksX, Math.floor(k / chunksX), bytes);
      live.set(k, bytes);
    }
    expect([...got.keys()].sort((a, b) => a - b)).toEqual([...live.keys()].sort((a, b) => a - b));
    for (const [k, v] of live) expect(got.get(k), `chunk ${k}`).toEqual(v);
    // Back to the start: what the agent had not seen yet is unknown again (the chunks are blanked, not left).
    c.set(0);
    await src.settled();
    await new Promise((r) => setTimeout(r, 100));
    const back = take();
    for (const [k, v] of back) expect(v.every((b) => b === 0) || live.has(k), `chunk ${k}`).toBe(true);
    stop();
    src.dispose();
  });

  it("refuses a run that was not recorded, one that does not exist, and says why", async () => {
    const ports = createMemoryPorts();
    await ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "n", status: "completed", recording: "none" });
    const c = cursorPort();
    const deps = { ports, replay: replayOver(ports), cursor: c.port };
    expect(await openReplaySource({ ...deps, runId: "run-000001" })).toMatchObject({ ok: false, error: { code: "not_recorded" } });
    expect(await openReplaySource({ ...deps, runId: "run-000002" })).toMatchObject({ ok: false, error: { code: "unknown_run" } });
    await ports.runs.create({ runId: "run-000003", schemaVersion: 0, createdAtWallMs: 1, label: "old", status: "completed" });
    const old = await openReplaySource({ ...deps, runId: "run-000003" });
    expect(!old.ok && old.error.message).toMatch(/before recording existed/);
  });
});

function t0Id(records: TraceRecord[]): string {
  return records.find((r) => r.kind === "observation" && r.agentId !== undefined)?.agentId ?? "";
}

// ---- scrubbing a live recorded run: the persisted head, the gap, and what is never asked (T-023) ---------------------------------------------

/** Ports and replay reads that remember the latest sim time and tick they were asked for. */
function watched(ports: StoragePorts) {
  const asked = { maxSimTime: 0, maxTick: 0, queries: 0 };
  const trace = {
    ...ports.trace,
    query: (q: Parameters<StoragePorts["trace"]["query"]>[0]) => {
      asked.queries++;
      asked.maxSimTime = Math.max(asked.maxSimTime, q.simTime?.to ?? 0);
      return ports.trace.query(q);
    },
  };
  const replay = replayOver(ports);
  return {
    asked,
    ports: { runs: ports.runs, trace },
    replay: {
      world: replay.world,
      beliefAt: (r: string, a: string, t: number, v?: Parameters<typeof beliefAt>[4]) => {
        asked.maxTick = Math.max(asked.maxTick, t);
        return replay.beliefAt(r, a, t, v);
      },
    },
  };
}

describe("scrubbing a live recorded run", () => {
  it("ends at the persisted head, which grows; a cursor in the gap is held at the head and nothing past it is asked of storage", async () => {
    resetReplayCache();
    const { ports, t } = await recorded(100);
    const w = watched(ports);
    const c = cursorPort();
    let persisted = 5; // the storage holds the first 5 s; the sim is at tick 100 (10 s)
    const listeners = new Set<() => void>();
    const src = await (async () => {
      const r = await openReplaySource({ runId: "run-000001", ports: w.ports, replay: w.replay, cursor: c.port, refreshMs: 0, head: { get: () => persisted, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }, simHeadTick: () => 100 });
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    })();
    expect(src.snapshot()).toMatchObject({ persistedHeadTick: 100, simHeadTick: 100 }); // the open read what the records say: all of it is in this fixture
    // The head the storage worker reports is the end of what can be shown: a fixture where the report is behind the records changes nothing here.
    persisted = 0;
    for (const l of listeners) l();
    const t0 = w.asked.maxTick;
    c.set(9.5);
    await src.settled();
    expect(w.asked.maxSimTime).toBeLessThanOrEqual(src.headSeconds + 1e-5);
    expect(src.snapshot().replay?.simHeadS).toBeCloseTo(10, 6);
    expect(w.asked.maxTick).toBeGreaterThanOrEqual(t0);
    expect(t.world.entityIds.length).toBeGreaterThan(0);
    src.dispose();
    expect(listeners.size).toBe(0);
  });

  it("with a persisted head behind the sim, the cursor never goes past the head and no read is for a later moment", async () => {
    resetReplayCache();
    const { ports } = await recorded(100);
    // Keep only the first 5 s of the run's records, as a storage that is behind would hold them.
    const behind = createMemoryPorts();
    const header = await ports.runs.get("run-000001");
    if (!header) throw new Error("no header");
    await behind.scenarios.saveVersion(f2DiscoveryScenario());
    await behind.runs.create(header);
    for (const item of [] as never[]) void item;
    const all = await ports.trace.query({ runId: "run-000001", limit: 10_000 });
    await behind.trace.append(all.filter((r) => r.simTime <= 5 + 1e-9));
    const frames = await ports.beliefFrames.query({ runId: "run-000001", limit: 10_000 });
    const kf = frames.filter((f) => f.kind === "keyframe" && f.tick <= 50);
    for (const f of kf) {
      const blob = await ports.snapshots.getBlob("run-000001", f.blobId ?? "");
      if (blob) await behind.snapshots.putBlobs("run-000001", [blob]);
    }
    const w = watched(behind);
    const c = cursorPort();
    let persisted = 5;
    const ls = new Set<() => void>();
    const r = await openReplaySource({ runId: "run-000001", ports: w.ports, replay: w.replay, cursor: c.port, refreshMs: 0, head: { get: () => persisted, subscribe: (l) => (ls.add(l), () => ls.delete(l)) }, simHeadTick: () => 100 });
    if (!r.ok) throw new Error(r.error.message);
    const src = r.value;
    expect(src.headSeconds).toBeCloseTo(5, 6);
    expect(src.snapshot()).toMatchObject({ persistedHeadTick: 50, simHeadTick: 100 });
    expect(src.snapshot().replay).toMatchObject({ headS: 5, simHeadS: 10 });
    c.set(9); // in the gap
    await src.settled();
    expect(src.snapshot().tick).toBe(50); // held at the persisted head
    expect(w.asked.maxSimTime).toBeLessThanOrEqual(5 + 1e-5);
    expect(poseAt(src, 0).x).toBeDefined();
    // The storage flushes more: the head moves, a listener hears it, and the same cursor now shows its own moment.
    persisted = 8;
    await behind.trace.append(all.filter((x) => x.simTime > 5 + 1e-9 && x.simTime <= 8 + 1e-9));
    let heard = 0;
    src.onHead(() => heard++);
    for (const l of ls) l();
    await src.settled();
    expect(heard).toBe(1);
    expect(src.headSeconds).toBeCloseTo(8, 6);
    c.set(8);
    await src.settled();
    expect(src.snapshot().tick).toBe(80);
    expect(w.asked.maxSimTime).toBeLessThanOrEqual(8 + 1e-5);
    src.dispose();
  });

  it("answers a burst of cursor moves with a few reads, not one per move, and the last move wins", async () => {
    resetReplayCache();
    const { ports, live, t } = await recorded(100);
    const w = watched(ports);
    const c = cursorPort();
    const r = await openReplaySource({ runId: "run-000001", ports: w.ports, replay: w.replay, cursor: c.port, refreshMs: 100 });
    if (!r.ok) throw new Error(r.error.message);
    const src = r.value;
    await src.settled();
    const before = w.asked.queries;
    for (let i = 0; i < 60; i++) c.set((i % 20) * 0.5);
    c.set(7);
    await src.settled();
    const used = w.asked.queries - before;
    expect(used, `reads for 61 moves: ${used}`).toBeLessThanOrEqual(12);
    const id = t.world.entityIds[0] ?? "";
    expect(Math.fround(poseAt(src, 0).x ?? 0)).toBe(Math.fround(live.at.get(70)?.get(id)?.x ?? 0));
    src.dispose();
  });

  it("shows the nearest keyframe overlay as it was at the keyframe, then the refinement with the deltas", async () => {
    resetReplayCache();
    const { ports, t } = await recorded(100);
    const id = t.driver;
    const coarse = await beliefAt(ports, "run-000001", id, 100, { keyframeOnly: true });
    const full = await beliefAt(ports, "run-000001", id, 100);
    if (!coarse.ok || !full.ok) throw new Error("a read failed");
    expect(coarse.value.deltasApplied).toBe(0);
    expect(full.value.deltasApplied).toBeGreaterThan(0);
    expect(coarse.value.keyframeTick).toBe(full.value.keyframeTick);
    expect(coarse.value.data).not.toEqual(full.value.data); // the deltas changed something after the keyframe
  });
});
