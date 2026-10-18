import { Scheduler, SnapshotWriter, encodeValue } from "@agentsim/core";
import { BELIEF_GROUP_CHUNKS, F2_DISCOVERY_ID, F2_TWENTY_AGENTS_ID, f2DiscoveryScenario, f2PriorReferenceScenario, f2RunConfig, f2TwentyAgentsScenario, writeBeliefSections } from "@agentsim/scenarios";
import { BeliefMap, groupGeometry, groupOfChunk } from "@agentsim/spatial";
import { createStorageClient, type BeliefFrame, type StorageClient } from "@agentsim/storage";
import { RECORDING_PRESETS, RunRecorder, recordingProfileHash, type RecorderBatch, type RecorderItem, type RecordingProfile } from "@agentsim/trace";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioHostedWorld } from "../sim/hosted-world.ts";
import { RunRecording } from "../sim/run-recording.ts";

// F3a M3: the replay reads through the real storage worker (sqlite-wasm on OPFS) with the app's own replay module, and what they cost. The first
// test is part of the suite: what comes back equals the live run. The measurements run only with VITE_AGENTSIM_BENCH_REPLAY=1 (report only).

const MEASURE = !!import.meta.env["VITE_AGENTSIM_BENCH_REPLAY"];
const clients: { worker: Worker; client: StorageClient }[] = [];

async function spawn(): Promise<StorageClient> {
  // The app's storage worker: the real one, with the replay module it is built with.
  const worker = new Worker(new URL("./storage.worker.ts", import.meta.url), { type: "module" });
  const client = createStorageClient(worker, { quotaThresholdBytes: 0, resetOnOpen: true });
  clients.push({ worker, client });
  await client.ready();
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    if (c.client.status().state === "ready") await c.client.admin.close();
    c.worker.terminate();
  }
});

const profileOf = (edit: (p: RecordingProfile) => RecordingProfile = (p) => p): RecordingProfile => edit(JSON.parse(JSON.stringify(RECORDING_PRESETS["default-research"])) as RecordingProfile);

function record(scenario: unknown, runConfig: unknown, profile: RecordingProfile, ticks: number) {
  const loaded = ScenarioHostedWorld.load({ runId: "run-000001", scenario, scenarioVersion: 1, runConfig }, () => 0);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const world = loaded.value;
  const batches: RecorderBatch[] = [];
  const items: RecorderItem[] = [];
  const recorder = new RunRecorder({ buffer: world.trace, profile, send: (b) => batches.push(b), sendItem: (i) => items.push(i) });
  const recording = new RunRecording(world.recordingTarget(), recorder, profile);
  world.setTickHook(() => recording.afterTick());
  recording.start();
  recorder.headerStored();
  for (const id of world.entityIds) if (id.startsWith("ugv")) world.inject({ agentId: id, name: "explore", params: {} });
  const scheduler = new Scheduler(world, world.dtS);
  for (let t = 1; t <= ticks; t++) {
    scheduler.step();
    if (t % 8 === 0) recorder.collect(world.tick, world.simTimeS);
  }
  recorder.collect(world.tick, world.simTimeS);
  return { world, batches, items };
}

const headerOf = (runId: string, profile: RecordingProfile, scenarioId: string, scenarioVersion: number) => ({
  runId, schemaVersion: 0, createdAtWallMs: 1, label: runId, status: "running" as const, recording: "stored" as const,
  recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile), scenarioId, scenarioVersion,
});

async function storeItem(client: StorageClient, runId: string, item: RecorderItem): Promise<void> {
  if (item.type === "snapshot") {
    const r = await client.ports.snapshots.write(runId, { seq: item.seq, simTime: item.simTimeS, tick: item.tick, bytes: item.bytes, blobs: item.blobs });
    if (!r.ok && r.error.code !== "duplicate_snapshot") throw new Error(r.error.message);
  } else {
    const p = await client.ports.snapshots.putBlobs(runId, item.blobs);
    if (!p.ok) throw new Error(p.error.message);
    const r = await client.ports.beliefFrames.append(runId, item.frames);
    if (!r.ok) throw new Error(r.error.message);
  }
}

const itemTick = (i: RecorderItem | undefined): number => (i === undefined ? 0 : i.type === "snapshot" ? i.tick : (i.frames[0]?.tick ?? 0));

const reidentified = (b: RecorderBatch, runId: string) => b.records.map((x) => ({ ...x, runId, id: `${runId}#${x.seq}` }));

const classify = (m: BeliefMap) => {
  const out = new Map<number, Uint8Array>();
  for (const k of m.materializedIndices()) {
    const bytes = new Uint8Array(m.chunkSize * m.chunkSize);
    m.classifyChunk(k % m.chunksX, Math.floor(k / m.chunksX), bytes);
    out.set(k, bytes);
  }
  return out;
};

describe("replay reads through the real storage worker", () => {
  it("the belief map at a tick and the world equal the live run's, with the bytes transferred from the worker", async () => {
    const profile = profileOf((p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 6 } } }));
    const rec = record(f2DiscoveryScenario(), f2RunConfig(F2_DISCOVERY_ID, 1), profile, 150);
    const id = rec.world.entityIds.find((x) => x.startsWith("ugv")) ?? "";
    const live = classify(rec.world.recordingTarget().run.sensing.belief(id));
    const client = await spawn();
    const saved = await client.ports.scenarios.saveVersion(f2DiscoveryScenario());
    if (!saved.ok) throw new Error(saved.error.message);
    const created = await client.ports.runs.create(headerOf("run-000001", profile, saved.value.id, saved.value.version));
    if (!created.ok) throw new Error(created.error.message);
    for (const item of rec.items) await storeItem(client, "run-000001", item);
    for (const b of rec.batches) {
      const r = await client.ports.trace.append(reidentified(b, "run-000001"));
      if (!r.ok) throw new Error(r.error.message);
    }
    const belief = await client.replay.beliefAt("run-000001", id, 150);
    if (!belief.ok) throw new Error(belief.error.message);
    const n = belief.value.chunkSize ** 2;
    const chunksX = Math.ceil(belief.value.sizeX / belief.value.chunkSize);
    expect(belief.value.coords.length / 2).toBe(live.size);
    for (let i = 0; i < belief.value.coords.length / 2; i++) {
      const k = (belief.value.coords[i * 2 + 1] ?? 0) * chunksX + (belief.value.coords[i * 2] ?? 0);
      expect(belief.value.data.subarray(i * n, (i + 1) * n), `chunk ${k}`).toEqual(live.get(k));
    }
    const grid = rec.world.gridMessage();
    const world = await client.replay.world("run-000001");
    if (!world.ok) throw new Error(world.error.message);
    expect([world.value.sizeX, world.value.sizeY, world.value.chunkSize, world.value.zones]).toEqual([grid.sizeX, grid.sizeY, grid.chunkSize, grid.zones]);
    expect(await client.replay.beliefAt("run-000009", id, 1)).toMatchObject({ ok: false, error: { code: "unknown_run" } });
  }, 120_000);
});

// ---- measurements ---------------------------------------------------------------------------------------------------------------------------

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? Number.NaN;
  return `p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${(s.at(-1) ?? 0).toFixed(1)} ms (n=${s.length})`;
};
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
const timed = async <T,>(f: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const v = await f();
  return [performance.now() - t0, v];
};

/** A belief map of a fully observed 1 km² world with height bounds in every chunk. */
function fullMap(): BeliefMap {
  const map = new BeliefMap(2000, 2000, 64);
  const cells = 64 * 64;
  map.applyChunks(
    Array.from({ length: 32 * 32 }, (_, index) => {
      const logOdds = new Int8Array(cells);
      for (let i = 0; i < cells; i++) logOdds[i] = ((index * 31 + i * 7) % 201) - 100;
      return {
        index,
        logOdds,
        knownMinDm: Uint16Array.from({ length: cells }, (_, i) => (i * 13 + index) % 300),
        knownMaxDm: Uint16Array.from({ length: cells }, (_, i) => ((i * 13 + index) % 300) + 5),
      };
    }),
  );
  return map;
}

describe.skipIf(!MEASURE)("replay measurements (report only)", () => {
  it("worst-case belief rebuild, first overlay, the world, and the reads made while a 20-agent run records", async ({ annotate }) => {
    const out: string[] = [];
    const say = (s: string) => out.push(s);
    const client = await spawn();
    // Run A (one per group size): a fully observed 1 km² map with heights (20 MiB of groups) and the longest run of cell deltas K = 30 s allows (300 at 10 Hz).
    const live = fullMap();
    live.trackCellChanges();
    for (let k = 0; k < 16 * 50; k++) {
      const chunk = ((k % 16) * 37) % 1024;
      live.observeFree((chunk % 32) * 64 + ((k * 7) % 64), Math.floor(chunk / 32) * 64 + ((k * 13) % 64), 3);
    }
    const taken = live.takeCellDelta();
    if (!taken) throw new Error("no delta taken");
    const deltaBytes = encodeValue(taken.delta);
    const profile = profileOf();
    const saved = await client.ports.scenarios.saveVersion(f2PriorReferenceScenario());
    if (!saved.ok) throw new Error(saved.error.message);
    const sizes = [4, 8, 16];
    const runOf = (g: number) => `run-0000${10 + sizes.indexOf(g)}`;
    const table: string[] = [];
    for (const g of sizes) {
      const runId = runOf(g);
      const external = new Map<string, Uint8Array>();
      const ref = writeBeliefSections(new SnapshotWriter({ external: (h, bytes) => external.set(h, bytes) }), fullMap().snapshot(), g);
      await client.ports.runs.create(headerOf(runId, profile, saved.value.id, saved.value.version));
      await client.ports.snapshots.putBlobs(runId, [...external].map(([id, bytes]) => ({ id, bytes })));
      const frames: BeliefFrame[] = [{ agentId: "ugv-001", seq: 0, tick: 0, simTime: 0, kind: "keyframe", chunks: Array.from({ length: 1024 }, (_, i) => i), blobId: ref.hash }];
      for (let t = 1; t <= 300; t++) frames.push({ agentId: "ugv-001", seq: t, tick: t, simTime: t / 10, kind: "delta", chunks: taken.chunks, data: deltaBytes });
      const appended = await client.ports.beliefFrames.append(runId, frames);
      if (!appended.ok) throw new Error(appended.error.message);
      const sizeBytes = [...external.values()].reduce((n, x) => n + x.length, 0);
      // The first overlay: the groups that cover a 12 x 12 chunk window around the middle of the map (about 380 m a side), nearest first.
      const geo = groupGeometry(2000, 2000, 64, g);
      const window = new Set<number>();
      for (let cj = 10; cj < 22; cj++) for (let ci = 10; ci < 22; ci++) window.add(groupOfChunk(geo, cj * geo.chunksX + ci));
      const focus = { ci: 16, cj: 16 };
      const first = await timed(() => client.replay.beliefAt(runId, "ugv-001", 300, { focus, limit: window.size }));
      const rest = await timed(() => client.replay.beliefAt(runId, "ugv-001", 300, { focus, skip: window.size }));
      const fullCold = first[1].ok && rest[1].ok ? first[0] + rest[0] : Number.NaN;
      const warm: number[] = [];
      const worker: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await timed(() => client.replay.beliefAt(runId, "ugv-001", 300, { focus }));
        warm.push(r[0]);
        const t = r[1].ok ? r[1].value.timingsMs : undefined;
        worker.push(t ? t.blob + t.deltas + t.classify : Number.NaN);
      }
      const f = first[1].ok ? first[1].value : undefined;
      table.push(
        `${g} x ${g} chunks: ${geo.groupsX * geo.groupsY} groups of ~${(sizeBytes / (geo.groupsX * geo.groupsY) / 1048576).toFixed(2)} MiB (${(sizeBytes / 1048576).toFixed(1)} MiB in all); first overlay = ${window.size} nearest groups (${f ? f.coords.length / 2 : "?"} chunks): ${first[0].toFixed(0)} ms cold (worker ${first[1].ok ? (first[1].value.timingsMs?.blob ?? 0).toFixed(0) : "?"} ms reading); rest: ${rest[0].toFixed(0)} ms; whole map cold ${fullCold.toFixed(0)} ms; whole map cached: round trip median ${med(warm).toFixed(0)} ms (max ${Math.max(...warm).toFixed(0)}), worker time median ${med(worker).toFixed(0)} ms`,
      );
    }
    say(`run A: 20 MiB of belief groups for a fully observed 1 km² map with heights, 300 deltas of ${taken.delta.cells.length} cells in ${taken.chunks.length} chunks, tick 300:`);
    for (const row of table) say(`  ${row}`);
    const gMain = BELIEF_GROUP_CHUNKS;
    const mainRun = runOf(gMain);
    const w1 = await timed(() => client.replay.world(mainRun));
    const w2: number[] = [];
    for (let i = 0; i < 3; i++) w2.push((await timed(() => client.replay.world(mainRun)))[0]);
    say(`world of the 1 km² run (scenario load and ${((2000 * 2000 * 4) / 1048576).toFixed(0)} MiB of atlas chunks), request to bytes: first ${w1[0].toFixed(0)} ms, warm median ${med(w2).toFixed(0)} ms`);

    if (import.meta.env["VITE_AGENTSIM_BENCH_REPLAY"] === "A") {
      const text = out.join(String.fromCharCode(10));
      await annotate(text, "replay-measurements");
      console.log(`REPLAY MEASUREMENTS ${text}`);
      return;
    }
    // Run B: the 20-agent run recorded at 1x into the same worker, while reads are made against run A and run B.
    const twentyProfile = profileOf();
    const rec = record(f2TwentyAgentsScenario(), f2RunConfig(F2_TWENTY_AGENTS_ID, 1), twentyProfile, 1200);
    const savedB = await client.ports.scenarios.saveVersion(f2TwentyAgentsScenario());
    if (!savedB.ok) throw new Error(savedB.error.message);
    await client.ports.runs.create(headerOf("run-000002", twentyProfile, savedB.value.id, savedB.value.version));
    const writes: number[] = [];
    const reads = { belief: [] as number[], agent: [] as number[], pose: [] as number[], kind: [] as number[] };
    let done = false;
    const writer = (async () => {
      let nextItem = 0;
      for (const b of rec.batches) {
        while (nextItem < rec.items.length && itemTick(rec.items[nextItem]) <= b.tick) {
          const item = rec.items[nextItem++];
          if (item) await storeItem(client, "run-000002", item);
        }
        const [t, r] = await timed(() => client.ports.trace.append(reidentified(b, "run-000002")));
        if (!r.ok) throw new Error(r.error.message);
        writes.push(t);
        await new Promise((r2) => setTimeout(r2, 800)); // a poll of 8 ticks at 10 Hz
      }
      done = true;
    })();
    while (!done) {
      reads.belief.push((await timed(() => client.replay.beliefAt(mainRun, "ugv-001", 300)))[0]);
      reads.agent.push((await timed(() => client.ports.trace.query({ runId: "run-000002", agentId: "ugv-001", limit: 200 })))[0]);
      reads.pose.push((await timed(() => client.ports.trace.query({ runId: "run-000002", kinds: ["observation"], op: "pose", simTime: { from: 10, to: 20 }, limit: 2000 })))[0]);
      reads.kind.push((await timed(() => client.ports.trace.query({ runId: "run-000002", kinds: ["action"], limit: 200 })))[0]);
      await new Promise((r) => setTimeout(r, 300));
    }
    await writer;
    say(`while run B records at 1x (${rec.batches.length} polls of 8 ticks, 20 agents): append of a poll's batch ${stats(writes)}`);
    say(`  reads made meanwhile: belief rebuild of run A (20 MiB) ${stats(reads.belief)}`);
    say(`  agent filter (200 records) ${stats(reads.agent)}; pose window 10 s (up to 2000 records) ${stats(reads.pose)}; kind filter (200 records) ${stats(reads.kind)}`);
    const idle = { agent: [] as number[], pose: [] as number[], kind: [] as number[] };
    for (let i = 0; i < 20; i++) {
      idle.agent.push((await timed(() => client.ports.trace.query({ runId: "run-000002", agentId: "ugv-001", limit: 200 })))[0]);
      idle.pose.push((await timed(() => client.ports.trace.query({ runId: "run-000002", kinds: ["observation"], op: "pose", simTime: { from: 10, to: 20 }, limit: 2000 })))[0]);
      idle.kind.push((await timed(() => client.ports.trace.query({ runId: "run-000002", kinds: ["action"], limit: 200 })))[0]);
    }
    say(`  the same reads with nothing recording: agent ${stats(idle.agent)}; pose window ${stats(idle.pose)}; kind ${stats(idle.kind)}`);
    console.log(`REPLAY MEASUREMENTS\n${out.join("\n")}`);
    expect(reads.belief.length).toBeGreaterThan(0);
  }, 600_000);
});
