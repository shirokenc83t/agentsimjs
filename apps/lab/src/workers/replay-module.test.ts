import { f2DiscoveryScenario } from "@agentsim/scenarios";
import { createMemoryPorts, type StoragePorts } from "@agentsim/storage";
import { recordingProfileHash, type RecorderItem } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { framesOf, profileOf, setup } from "../sim/run-recording-harness.ts";
import { beliefAt, world } from "./replay-module.ts";

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
