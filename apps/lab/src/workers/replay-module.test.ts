import { SnapshotWriter, contentHash128Bytes, decodeValue, encodeValue, readSnapshot } from "@agentsim/core";
import { checkBeliefManifest, f2DiscoveryScenario, writeBeliefSections } from "@agentsim/scenarios";
import { BELIEF_MANIFEST_FORMAT, BeliefMap } from "@agentsim/spatial";
import { BELIEF_MANIFEST_FORMAT_STORED, createMemoryPorts, type StoragePorts } from "@agentsim/storage";
import { recordingProfileHash, type RecorderItem } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { framesOf, profileOf, setup } from "../sim/run-recording-harness.ts";
import { beliefAt, replayCacheStats, resetReplayCache, world } from "./replay-module.ts";

// F3a M3: what replay rebuilds from storage alone equals what the live run had (belief overlay bytes at a tick, the Scene's grid and chunks).

async function store(ports: StoragePorts, items: RecorderItem[], profile: ReturnType<typeof profileOf>, scenario = true) {
  let ref: { scenarioId?: string; scenarioVersion?: number } = {};
  if (scenario) {
    const saved = await ports.scenarios.saveVersion(f2DiscoveryScenario());
    if (!saved.ok) throw new Error(saved.error.message);
    ref = { scenarioId: saved.value.id, scenarioVersion: saved.value.version };
  }
  const created = await ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "x", status: "completed", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile), ...ref });
  if (!created.ok) throw new Error(created.error.message);
  for (const item of items) {
    if (item.type === "snapshot") {
      const r = await ports.snapshots.write(item.runId, { seq: item.seq, simTime: item.simTimeS, tick: item.tick, bytes: item.bytes, blobs: item.blobs });
      if (!r.ok && r.error.code !== "duplicate_snapshot") throw new Error(r.error.message);
    } else {
      await ports.snapshots.putBlobs(item.runId, item.blobs);
      const r = await ports.beliefFrames.append(item.runId, item.frames);
      if (!r.ok) throw new Error(r.error.message);
    }
  }
}

/** The overlay bytes the live map has now: `classifyChunk` of every materialized chunk, by chunk index. */
function liveChunks(belief: { materializedIndices(): readonly number[]; chunksX: number; chunkSize: number; classifyChunk(ci: number, cj: number, out: Uint8Array): boolean }): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (const k of belief.materializedIndices()) {
    const bytes = new Uint8Array(belief.chunkSize * belief.chunkSize);
    belief.classifyChunk(k % belief.chunksX, Math.floor(k / belief.chunksX), bytes);
    out.set(k, bytes);
  }
  return out;
}

describe("replay module: the belief map of an agent at a tick", () => {
  it("equals the live map's overlay bytes at keyframe ticks, between them, and at the last tick", async () => {
    const profile = profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 6 } } }));
    const t = setup(profile);
    const id = t.driver;
    t.explore(id);
    const belief = t.world.recordingTarget().run.sensing.belief(id);
    const live = new Map<number, Map<number, Uint8Array>>();
    const want = new Set([0, 1, 33, 60, 61, 119, 120, 121, 200]);
    for (let i = 1; i <= 200; i++) {
      t.step(1);
      if (want.has(i)) live.set(i, liveChunks(belief));
    }
    live.set(0, new Map());
    const ports = createMemoryPorts();
    await store(ports, t.items, profile);
    for (const tick of [...want].filter((n) => n > 0)) {
      const r = await beliefAt(ports, "run-000001", id, tick);
      if (!r.ok) throw new Error(r.error.message);
      const expected = live.get(tick) as Map<number, Uint8Array>;
      const got = new Map<number, Uint8Array>();
      const n = r.value.chunkSize * r.value.chunkSize;
      for (let i = 0; i < r.value.coords.length / 2; i++) got.set((r.value.coords[i * 2 + 1] ?? 0) * Math.ceil(r.value.sizeX / r.value.chunkSize) + (r.value.coords[i * 2] ?? 0), r.value.data.subarray(i * n, (i + 1) * n));
      expect([...got.keys()].sort((a, b) => a - b), `chunks at tick ${tick}`).toEqual([...expected.keys()].sort((a, b) => a - b));
      for (const [k, bytes] of expected) expect(got.get(k), `chunk ${k} at tick ${tick}`).toEqual(bytes);
      expect(r.value.keyframeTick).toBe(Math.floor(tick / 60) * 60);
      expect(r.value.tick).toBe(tick);
    }
    expect(framesOf(t.items).length).toBeGreaterThan(0);
  });

  it("says why it cannot: unknown run, run not recorded, unknown agent", async () => {
    const ports = createMemoryPorts();
    expect(await beliefAt(ports, "run-000009", "ugv-001", 1)).toMatchObject({ ok: false, error: { code: "unknown_run" } });
    await ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "x", status: "completed", recording: "none" });
    expect(await beliefAt(ports, "run-000001", "ugv-001", 1)).toMatchObject({ ok: false, error: { code: "not_recorded" } });
    const profile = profileOf("default-research");
    const t = setup(profile);
    t.step(5);
    const stored = createMemoryPorts();
    await store(stored, t.items, profile);
    expect(await beliefAt(stored, "run-000001", "nobody-001", 3)).toMatchObject({ ok: false, error: { code: "unknown_agent" } });
  });
});

describe("replay module: the world a run was made in", () => {
  it("is the Scene's grid message and atlas chunks, byte for byte", async () => {
    const profile = profileOf("default-research");
    const t = setup(profile);
    const ports = createMemoryPorts();
    await store(ports, t.items, profile);
    const r = await world(ports, "run-000001");
    if (!r.ok) throw new Error(r.error.message);
    const grid = t.world.gridMessage();
    expect({ sizeX: r.value.sizeX, sizeY: r.value.sizeY, resolutionM: r.value.resolutionM, chunkSize: r.value.chunkSize, zones: r.value.zones, h: r.value.defaultObstacleHeightM }).toEqual({
      sizeX: grid.sizeX, sizeY: grid.sizeY, resolutionM: grid.resolutionM, chunkSize: grid.chunkSize, zones: grid.zones, h: grid.defaultObstacleHeightM,
    });
    const live = t.world.drainChunks();
    const per = r.value.chunkSize * r.value.chunkSize * 4;
    const liveByKey = new Map<number, Uint8Array>();
    const chunksX = Math.ceil(grid.sizeX / grid.chunkSize);
    for (const m of live) for (let i = 0; i < m.coords.length / 2; i++) liveByKey.set((m.coords[i * 2 + 1] ?? 0) * chunksX + (m.coords[i * 2] ?? 0), m.data.subarray(i * per, (i + 1) * per));
    expect(r.value.coords.length / 2).toBe(liveByKey.size);
    for (let i = 0; i < r.value.coords.length / 2; i++) {
      const key = (r.value.coords[i * 2 + 1] ?? 0) * chunksX + (r.value.coords[i * 2] ?? 0);
      expect(r.value.data.subarray(i * per, (i + 1) * per), `chunk ${key}`).toEqual(liveByKey.get(key));
    }
  });

  it("says why it cannot: a run without a stored scenario, a scenario that is gone", async () => {
    const ports = createMemoryPorts();
    await ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "x", status: "completed" });
    expect(await world(ports, "run-000001")).toMatchObject({ ok: false, error: { code: "scenario_missing" } });
    expect(await world(ports, "run-000002")).toMatchObject({ ok: false, error: { code: "unknown_run" } });
  });
});

// ---- chunk groups: views, the keyframe cache, reading ahead, sharing (T-027) -------------------------------------------------------------

const AGENT = "uav-001";

/**
 * A recorded map of 13 × 9 chunks in groups of 4 × 4 (12 groups): keyframes at ticks 0 and 60, one cell delta per tick between them, the map growing to the
 * right as it goes. The recorder writes keyframes and deltas through the same functions; the 64 m worlds of the recorded runs are one group.
 */
async function syntheticRun(groupChunks = 4) {
  const map = new BeliefMap(200, 130, 16);
  map.trackCellChanges();
  const profile = profileOf("default-research");
  const ports = createMemoryPorts();
  await ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "s", status: "completed", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) });
  const frames: Parameters<StoragePorts["beliefFrames"]["append"]>[1][number][] = [];
  let seq = 0;
  const keyframe = async (tick: number) => {
    const external = new Map<string, Uint8Array>();
    const ref = writeBeliefSections(new SnapshotWriter({ external: (h, b) => external.set(h, b) }), map.snapshot(), groupChunks);
    await ports.snapshots.putBlobs("run-000001", [...external].map(([id, bytes]) => ({ id, bytes })));
    frames.push({ agentId: AGENT, seq: seq++, tick, simTime: tick / 10, kind: "keyframe", chunks: map.materializedIndices(), blobId: ref.hash });
    map.takeCellDelta();
    return ref.hash;
  };
  const observeAt = (tick: number) => {
    // The first ticks observe near the left edge (the first group column); after that the map grows to the right, and that group never changes again.
    const column = tick <= 6 ? 4 + tick * 3 : Math.min(199, 70 + (tick - 6) * 2);
    for (let j = 0; j < 130; j += 9) map.observeFree(column, j, 3);
  };
  for (let tick = 0; tick <= 6; tick++) observeAt(tick);
  const kf0 = await keyframe(0);
  for (let tick = 1; tick < 60; tick++) {
    observeAt(tick + 6);
    const taken = map.takeCellDelta();
    if (taken) frames.push({ agentId: AGENT, seq: seq++, tick, simTime: tick / 10, kind: "delta", chunks: taken.chunks, data: encodeValue(taken.delta) });
  }
  const kf60 = await keyframe(60);
  for (let tick = 61; tick <= 100; tick++) {
    observeAt(tick + 6);
    const taken = map.takeCellDelta();
    if (taken) frames.push({ agentId: AGENT, seq: seq++, tick, simTime: tick / 10, kind: "delta", chunks: taken.chunks, data: encodeValue(taken.delta) });
  }
  const appended = await ports.beliefFrames.append("run-000001", frames);
  if (!appended.ok) throw new Error(appended.error.message);
  return { ports, kf0, kf60 };
}

const chunksX = 13;
const keyOf = (r: { coords: Uint16Array }, i: number) => (r.coords[i * 2 + 1] ?? 0) * chunksX + (r.coords[i * 2] ?? 0);
const bytesOf = (r: { coords: Uint16Array; data: Uint8Array; chunkSize: number }) => new Map(Array.from({ length: r.coords.length / 2 }, (_, i) => [keyOf(r, i), r.data.subarray(i * r.chunkSize ** 2, (i + 1) * r.chunkSize ** 2)] as const));

describe("replay module: chunk groups", () => {
  it("the manifest format the storage checks on import is the one the spatial package writes", () => {
    expect(BELIEF_MANIFEST_FORMAT_STORED).toBe(BELIEF_MANIFEST_FORMAT);
  });

  it("returns the groups nearest the focus first, and two reads (nearest, then the rest) make the whole map", async () => {
    resetReplayCache();
    const { ports } = await syntheticRun();
    const full = await beliefAt(ports, "run-000001", AGENT, 100);
    if (!full.ok) throw new Error(full.error.message);
    const total = full.value.groups.total;
    expect(total).toBeGreaterThan(4);
    const whole = bytesOf(full.value);
    for (const focus of [{ ci: 0, cj: 0 }, { ci: 12, cj: 8 }]) {
      const first = await beliefAt(ports, "run-000001", AGENT, 100, { focus, limit: 2 });
      const rest = await beliefAt(ports, "run-000001", AGENT, 100, { focus, skip: 2 });
      if (!first.ok || !rest.ok) throw new Error("a read failed");
      expect([first.value.groups.from, first.value.groups.to, rest.value.groups.from, rest.value.groups.to]).toEqual([0, 2, 2, total]);
      const a = bytesOf(first.value);
      const b = bytesOf(rest.value);
      expect([...a.keys()].some((k) => b.has(k))).toBe(false);
      expect(a.size).toBeGreaterThan(0);
      expect(a.size + b.size).toBe(whole.size);
      for (const [k, v] of [...a, ...b]) expect(v, `chunk ${k}`).toEqual(whole.get(k));
      // The first read's chunks are the ones near the focus: the farthest of them is no farther than the nearest of the rest, by group.
      const g = (k: number) => Math.max(Math.abs((k % chunksX) - focus.ci), Math.abs(Math.floor(k / chunksX) - focus.cj));
      expect(Math.min(...[...a.keys()].map(g))).toBeLessThanOrEqual(Math.min(...[...b.keys()].map(g)));
    }
  });

  it("keeps decoded groups: a second read of the same tick reads nothing, a read in the same keyframe reads nothing more", async () => {
    resetReplayCache();
    const { ports } = await syntheticRun();
    const cold = await beliefAt(ports, "run-000001", AGENT, 30);
    if (!cold.ok) throw new Error(cold.error.message);
    expect(cold.value.groups.read).toBeGreaterThan(0);
    expect(cold.value.groups.cached).toBe(0);
    const warm = await beliefAt(ports, "run-000001", AGENT, 30);
    if (!warm.ok) throw new Error(warm.error.message);
    expect(warm.value.groups.read).toBe(0);
    expect(warm.value.groups.cached).toBe(cold.value.groups.read);
    expect(warm.value.coords).toEqual(cold.value.coords);
    expect(warm.value.data).toEqual(cold.value.data);
    const later = await beliefAt(ports, "run-000001", AGENT, 55); // the same keyframe (tick 0), more deltas
    if (!later.ok) throw new Error(later.error.message);
    expect(later.value.groups.read).toBe(0);
    expect(later.value.deltasApplied).toBeGreaterThan(warm.value.deltasApplied);
  });

  it("reads the neighbouring keyframes ahead while nothing else asks, and an unchanged group is cached once for both", async () => {
    resetReplayCache();
    const { ports, kf0, kf60 } = await syntheticRun();
    const hashes = async (hash: string) => checkBeliefManifest(decodeValue((await ports.snapshots.getBlob("run-000001", hash))?.bytes ?? new Uint8Array())).groups.map((g) => g.hash);
    const wanted = new Set([...(await hashes(kf0)), ...(await hashes(kf60))]);
    expect(wanted.size).toBeLessThan((await hashes(kf0)).length + (await hashes(kf60)).length); // some groups did not change between the two
    const r = await beliefAt(ports, "run-000001", AGENT, 20); // keyframe 0: the next is 60
    if (!r.ok) throw new Error(r.error.message);
    for (let i = 0; i < 100 && replayCacheStats().groups < wanted.size; i++) await new Promise((res) => setTimeout(res, 20));
    expect(replayCacheStats().groups).toBe(wanted.size);
    const next = await beliefAt(ports, "run-000001", AGENT, 65);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.groups.read).toBe(0);
    // And going back: the keyframe before is read ahead too.
    const back = await beliefAt(ports, "run-000001", AGENT, 40);
    expect(back.ok && back.value.groups.read).toBe(0);
  });

  it("stops reading ahead when another read arrives, and refuses a map stored whole with its own code", async () => {
    resetReplayCache();
    const { ports } = await syntheticRun();
    const first = await beliefAt(ports, "run-000001", AGENT, 10);
    const second = await beliefAt(ports, "run-000001", AGENT, 11);
    expect(first.ok && second.ok).toBe(true);
    // A keyframe whose blob is a whole map (format 1 of the snapshot, from development) is refused, not misread.
    const whole = encodeValue(new BeliefMap(200, 130, 16).snapshot());
    const blobId = contentHash128Bytes(whole);
    const profile = profileOf("default-research");
    const old = createMemoryPorts();
    await old.runs.create({ runId: "run-000002", schemaVersion: 0, createdAtWallMs: 1, label: "old", status: "completed", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile) });
    await old.snapshots.putBlobs("run-000002", [{ id: blobId, bytes: whole }]);
    await old.beliefFrames.append("run-000002", [{ agentId: AGENT, seq: 0, tick: 0, simTime: 0, kind: "keyframe", chunks: [0], blobId }]);
    expect(await beliefAt(old, "run-000002", AGENT, 5)).toMatchObject({ ok: false, error: { code: "unsupported_recording" } });
  });

  it("a recorded run: a group is handed over once, and a snapshot's belief manifests are its keyframes' blobs", async () => {
    const profile = profileOf("default-research", (p) => ({ ...p, checkpoints: { ...p.checkpoints, snapshotEveryS: 6 }, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 6 } } }));
    const t = setup(profile);
    t.explore(t.driver);
    t.step(130);
    const ids = t.items.flatMap((i) => i.blobs.map((b) => b.id));
    expect(new Set(ids).size, "no blob is handed over twice").toBe(ids.length);
    const snapshots = t.items.filter((i) => i.type === "snapshot");
    expect(snapshots.map((s) => s.tick)).toEqual([0, 60, 120]);
    const keyframes = framesOf(t.items).filter((f) => f.kind === "keyframe");
    for (const s of snapshots) {
      const root = readSnapshot(s.bytes).root as { sensing: { agents: { agentId: string; belief: { hash: string } }[] } };
      for (const a of root.sensing.agents) {
        const kf = keyframes.find((f) => f.agentId === a.agentId && f.tick === s.tick);
        if (kf) expect(kf.blobId, `${a.agentId} at tick ${s.tick}`).toBe(a.belief.hash);
      }
    }
  });
});
