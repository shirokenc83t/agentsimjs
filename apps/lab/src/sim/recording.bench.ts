import { Scheduler, decodeValue, encodeValue, readSnapshot } from "@agentsim/core";
import { F2_DISCOVERY_ID, F2_TWENTY_AGENTS_ID, f2DiscoveryScenario, f2PriorReferenceScenario, f2PriorRunConfig, f2RunConfig, f2TwentyAgentsScenario, snapshotRun } from "@agentsim/scenarios";
import { BeliefMap, type BeliefCellDelta, type BeliefMapSnapshot } from "@agentsim/spatial";
import { RECORDING_PRESETS, RunRecorder, channelOf, estimateRecordBytes, type RecorderBatch, type RecorderItem, type RecordingProfile, type TraceRecord } from "@agentsim/trace";
import { appendFileSync, mkdirSync } from "node:fs";
import { expect, it } from "vitest";
import { recordResults, summarize } from "../../../../tools/bench/measure.ts";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { RunRecording } from "./run-recording.ts";

// F3a M2 measurements (ADR-0035 addition of 2026-10-17, items 8, 9 and 12; ADR-0013 and ADR-0029 additions of the same date): what recording costs per
// tick, what it writes per agent-hour and per channel, the belief keyframe interval K (bytes and worst-case rebuild), snapshot volume with blob
// sharing. Report only: nothing here is a gate until Max decides on K, S and the per-tick budget. The tables are printed and stored in node.json.

const DT = 0.1;
/** These measurements take minutes: `pnpm bench` runs them only with AGENTSIM_BENCH_RECORDING=1 (report only, until K, S and the per-tick budget are decided). */
const RUN = !!process.env["AGENTSIM_BENCH_RECORDING"];
const measure_ = it.skipIf(!RUN);

/** Prints a table and appends it to bench/results/recording-tables.md (the console of a passing test is not always shown). */
function emit(text: string): void {
  mkdirSync("bench/results", { recursive: true });
  appendFileSync("bench/results/recording-tables.md", `${text}
`);
  console.log(text);
}
const profileWith = (name: keyof typeof RECORDING_PRESETS, edit: (p: RecordingProfile) => RecordingProfile = (p) => p): RecordingProfile => edit(JSON.parse(JSON.stringify(RECORDING_PRESETS[name])) as RecordingProfile);

type Kind = "discovery" | "twenty";
const WORLDS: Record<Kind, { doc: () => unknown; cfg: () => unknown; label: string }> = {
  discovery: { doc: () => f2DiscoveryScenario(), cfg: () => f2RunConfig(F2_DISCOVERY_ID, 1), label: "F2 discovery (3 agents)" },
  twenty: { doc: () => f2TwentyAgentsScenario(), cfg: () => f2RunConfig(F2_TWENTY_AGENTS_ID, 1), label: "F2 20 agents" },
};

function loadWorld(doc: unknown, cfg: unknown): ScenarioHostedWorld {
  const r = ScenarioHostedWorld.load({ runId: "run-000001", scenario: doc, scenarioVersion: 1, runConfig: cfg }, () => 0);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

interface Measured {
  readonly agents: number;
  readonly simSeconds: number;
  readonly stepMs: number[]; // per tick: the scheduler step, which includes the recording's tick hook
  readonly hookMs: number[]; // per tick: the recording's own hook (poses, deltas, checkpoints, snapshots)
  readonly pollMs: number[]; // per poll of 8 ticks: collect (profile, redaction, byte estimate) plus the structured clone of the batch
  readonly batches: RecorderBatch[];
  readonly items: RecorderItem[];
  readonly snapshotMs: number[]; // wall time of each snapshot taken by the recording (hook ticks that took one)
}

/** Runs `ticks` ticks of a world whose ground vehicles explore, recorded under `profile` as the sim worker does (or not recorded, `undefined`). */
function runMeasured(world: ScenarioHostedWorld, ticks: number, profile: RecordingProfile | undefined, poll = 8): Measured {
  const batches: RecorderBatch[] = [];
  const items: RecorderItem[] = [];
  let recorder: RunRecorder | undefined;
  let recording: RunRecording | undefined;
  const hookMs: number[] = [];
  const snapshotMs: number[] = [];
  if (profile) {
    recorder = new RunRecorder({ buffer: world.trace, profile, send: (b) => batches.push(b), sendItem: (i) => items.push(i) });
    recording = new RunRecording(world.recordingTarget(), recorder, profile);
    const rec = recording;
    let lastItems = 0;
    world.setTickHook(() => {
      const t0 = performance.now();
      rec.afterTick();
      const dt = performance.now() - t0;
      hookMs.push(dt);
      if (items.filter((i) => i.type === "snapshot").length > lastItems) {
        lastItems = items.filter((i) => i.type === "snapshot").length;
        snapshotMs.push(dt);
      }
    });
    recording.start();
    recorder.headerStored();
  }
  for (const id of world.entityIds) if (id.startsWith("ugv")) world.inject({ agentId: id, name: "explore", params: {} });
  const scheduler = new Scheduler(world, world.dtS);
  const stepMs: number[] = [];
  const pollMs: number[] = [];
  for (let t = 1; t <= ticks; t++) {
    const t0 = performance.now();
    scheduler.step();
    stepMs.push(performance.now() - t0);
    if (recorder && t % poll === 0) {
      const p0 = performance.now();
      const before = batches.length;
      recorder.collect(world.tick, world.simTimeS);
      for (const b of batches.slice(before)) structuredClone(b); // what postMessage costs the sender, copying the records
      pollMs.push(performance.now() - p0);
    }
  }
  recorder?.collect(world.tick, world.simTimeS);
  return { agents: world.entityIds.length, simSeconds: ticks * DT, stepMs, hookMs, pollMs, batches, items, snapshotMs };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const ms = (n: number) => `${n.toFixed(3)} ms`;
const table = (rows: (string | number)[][]) => rows.map((r) => r.join(" | ")).join("\n");
const sizeOfRecord = (r: TraceRecord) => JSON.stringify(r).length;

// ---- 1. what recording costs per tick: 20 agents exploring -------------------------------------------------------------------------------

measure_("recording cost per tick: 20 agents exploring, default-research and debug-full against not recorded", () => {
  const TICKS = 1300; // two snapshots at S = 60 s
  const arm = (profile: RecordingProfile | undefined) => {
    const w = loadWorld(WORLDS.twenty.doc(), WORLDS.twenty.cfg());
    return runMeasured(w, TICKS, profile);
  };
  arm(undefined); // warm up the JIT
  const base = arm(undefined);
  const arms = { "default-research": arm(RECORDING_PRESETS["default-research"]), "debug-full": arm(RECORDING_PRESETS["debug-full"]) };
  const steady = (xs: number[]) => xs.slice(100);
  const baseStep = summarize(steady(base.stepMs));
  const rows: (string | number)[][] = [["arm", "tick mean", "tick p95", "hook mean", "hook p95", "poll (8 ticks) mean", "poll p95", "added per tick (mean)", "added per tick (p95)"]];
  rows.push(["not recorded", ms(baseStep.mean), ms(baseStep.p95), "—", "—", "—", "—", "—", "—"]);
  const metrics: Record<string, ReturnType<typeof summarize>> = { "recording.tick.notRecorded": baseStep };
  for (const [name, m] of Object.entries(arms)) {
    const step = summarize(steady(m.stepMs));
    const hook = summarize(steady(m.hookMs));
    const poll = summarize(m.pollMs.slice(10));
    // The recorded tick costs the step (hook included) plus its share of the poll; per tick over the steady part.
    const perTick = steady(m.stepMs).map((v, i) => v + (m.pollMs[Math.floor((i + 100) / 8)] ?? 0) / 8);
    const added = summarize(perTick);
    rows.push([name, ms(step.mean), ms(step.p95), ms(hook.mean), ms(hook.p95), ms(poll.mean), ms(poll.p95), ms(added.mean - baseStep.mean), ms(added.p95 - baseStep.p95)]);
    metrics[`recording.tick.${name}`] = added;
    metrics[`recording.hook.${name}`] = hook;
    metrics[`recording.poll.${name}`] = poll;
    const snaps = summarize(m.snapshotMs);
    emit(`  snapshot ticks (${name}): n=${m.snapshotMs.length} mean ${ms(snaps.mean)} max ${ms(Math.max(...m.snapshotMs, 0))}; worst recorded tick ${ms(Math.max(...m.stepMs))}`);
  }
  recordResults("node.json", metrics);
  emit(`\nRecording cost per tick, ${WORLDS.twenty.label}, ${TICKS} ticks (the first 100 dropped):\n${table(rows)}`);
  expect(base.stepMs.length).toBe(TICKS);
});

// ---- 2. the cost of the per-record byte estimate (JSON.stringify of each payload) ---------------------------------------------------------

measure_("the per-record byte estimate: what JSON.stringify of each payload costs", () => {
  const w = loadWorld(WORLDS.twenty.doc(), WORLDS.twenty.cfg());
  const m = runMeasured(w, 600, RECORDING_PRESETS["default-research"]);
  const records = m.batches.flatMap((b) => b.records);
  expect(records.length).toBeGreaterThan(1000);
  const samples: number[] = [];
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    let sink = 0;
    for (const r of records) sink += estimateRecordBytes(r);
    samples.push(performance.now() - t0);
    expect(sink).toBeGreaterThan(0);
  }
  const perRecordUs = (summarize(samples.slice(1)).median * 1000) / records.length;
  const perTickMs = (summarize(samples.slice(1)).median / (m.simSeconds / DT));
  recordResults("node.json", { "recording.estimateBytesPerTick": summarize([perTickMs]) });
  emit(`\nByte estimate: ${records.length} records over ${m.simSeconds} s (${(records.length / (m.simSeconds / DT)).toFixed(1)} per tick): ${perRecordUs.toFixed(2)} µs per record, ${perTickMs.toFixed(4)} ms per tick`);
});

// ---- 3. what is written per agent-hour, per channel ---------------------------------------------------------------------------------------

interface Volume {
  readonly byChannel: Map<string, { count: number; bytes: number }>;
  readonly snapshotBytes: number;
  readonly keyframeBytes: number;
  readonly deltaBytes: number;
  readonly deltaFrames: number;
  readonly deltaChunks: number[];
  readonly keyframes: number;
  readonly snapshots: number;
  readonly snapshotContainerBytes: number;
}

function volumeOf(m: Measured): Volume {
  const byChannel = new Map<string, { count: number; bytes: number }>();
  for (const r of m.batches.flatMap((b) => b.records)) {
    const c = channelOf(r) ?? "unmapped";
    const e = byChannel.get(c) ?? { count: 0, bytes: 0 };
    e.count++;
    e.bytes += sizeOfRecord(r);
    byChannel.set(c, e);
  }
  let snapshotBytes = 0;
  let snapshotContainerBytes = 0;
  let keyframeBytes = 0;
  let deltaBytes = 0;
  let deltaFrames = 0;
  let keyframes = 0;
  let snapshots = 0;
  const deltaChunks: number[] = [];
  for (const i of m.items) {
    if (i.type === "snapshot") {
      snapshots++;
      snapshotContainerBytes += i.bytes.length;
      snapshotBytes += i.bytes.length + i.blobs.reduce((n, b) => n + b.bytes.length, 0);
    } else {
      keyframeBytes += i.blobs.reduce((n, b) => n + b.bytes.length, 0);
      for (const f of i.frames) {
        if (f.kind === "keyframe") keyframes++;
        else {
          deltaFrames++;
          deltaBytes += f.data?.length ?? 0;
          deltaChunks.push(f.chunks.length);
        }
      }
    }
  }
  return { byChannel, snapshotBytes, keyframeBytes, deltaBytes, deltaFrames, deltaChunks, keyframes, snapshots, snapshotContainerBytes };
}

measure_("bytes per agent-hour per channel: 20 agents exploring, default-research and debug-full", () => {
  const TICKS = 2400; // 4 minutes of sim time: snapshots at 0, 60, 120, 180, 240 s
  const rows: (string | number)[][] = [["profile", "channel", "records", "bytes (JSON)", "bytes / agent-hour"]];
  const metrics: Record<string, ReturnType<typeof summarize>> = {};
  for (const name of ["default-research", "debug-full"] as const) {
    const m = runMeasured(loadWorld(WORLDS.twenty.doc(), WORLDS.twenty.cfg()), TICKS, RECORDING_PRESETS[name]);
    const v = volumeOf(m);
    const perAgentHour = (bytes: number) => (bytes / m.agents) * (3600 / m.simSeconds);
    const lines: [string, number, number][] = [...v.byChannel.entries()].sort().map(([c, e]) => [c, e.count, e.bytes]);
    lines.push(["snapshots (containers + new blobs)", v.snapshots, v.snapshotBytes]);
    lines.push(["belief keyframes (new blobs)", v.keyframes, v.keyframeBytes]);
    lines.push(["belief deltas (inline)", v.deltaFrames, v.deltaBytes]);
    let total = 0;
    for (const [c, count, bytes] of lines) {
      rows.push([name, c, count, kb(bytes), kb(perAgentHour(bytes))]);
      total += bytes;
      metrics[`recording.bytesPerAgentHour.${name}.${c.split(" ")[0]}`] = summarize([perAgentHour(bytes)], "bytes");
    }
    rows.push([name, "TOTAL", "", kb(total), kb(perAgentHour(total))]);
    metrics[`recording.bytesPerAgentHour.${name}.total`] = summarize([perAgentHour(total)], "bytes");
  }
  recordResults("node.json", metrics);
  emit(`\nWritten per agent-hour, ${WORLDS.twenty.label}, ${TICKS} ticks (${TICKS * DT} s) on the 64 m world (16 chunks per map):\n${table(rows)}`);
});

// ---- 4. the belief keyframe interval K ----------------------------------------------------------------------------------------------------

/** A belief map of a fully observed 1 km² world (2,000 × 2,000 cells, chunks of 64: 1,024 chunks), with or without height bounds. */
function fullMap(withHeights: boolean): BeliefMap {
  const map = new BeliefMap(2000, 2000, 64);
  const cells = 64 * 64;
  const chunks = Array.from({ length: 32 * 32 }, (_, index) => {
    const logOdds = new Int8Array(cells);
    for (let i = 0; i < cells; i++) logOdds[i] = ((index * 31 + i * 7) % 201) - 100;
    return {
      index,
      logOdds,
      knownMinDm: withHeights ? Uint16Array.from({ length: cells }, (_, i) => (i * 13 + index) % 300) : undefined,
      knownMaxDm: withHeights ? Uint16Array.from({ length: cells }, (_, i) => ((i * 13 + index) % 300) + 5) : undefined,
    };
  });
  map.applyChunks(chunks);
  return map;
}

measure_("belief keyframes: bytes per agent-hour for K of 10, 30 and 60 s on the exploration scenarios", () => {
  const TICKS = 1800; // 3 minutes
  const rows: (string | number)[][] = [["scenario", "K", "keyframes / agent-hour", "keyframe bytes / agent-hour", "delta bytes / agent-hour", "total / agent-hour", "mean chunks per delta", "p95 chunks per delta", "deltas per second"]];
  const metrics: Record<string, ReturnType<typeof summarize>> = {};
  for (const kind of ["discovery", "twenty"] as const) {
    for (const K of [10, 30, 60]) {
      const profile = profileWith("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: K } }, checkpoints: { everyTicks: 100, snapshotEveryS: 3600 } }));
      const world = loadWorld(WORLDS[kind].doc(), WORLDS[kind].cfg());
      const m = runMeasured(world, TICKS, profile);
      const v = volumeOf(m);
      const beliefAgents = m.agents - (kind === "discovery" ? 3 : 0); // the discovery demo's agents are ideal: no maps; its table row is the start keyframe only
      void beliefAgents;
      const perHour = (b: number) => (b / m.agents) * (3600 / m.simSeconds);
      const chunks = summarize(v.deltaChunks, "count");
      rows.push([WORLDS[kind].label, `${K} s`, ((v.keyframes / m.agents) * (3600 / m.simSeconds)).toFixed(0), kb(perHour(v.keyframeBytes)), kb(perHour(v.deltaBytes)), kb(perHour(v.keyframeBytes + v.deltaBytes)), chunks.mean.toFixed(1), chunks.p95, (v.deltaFrames / m.simSeconds).toFixed(2)]);
      metrics[`recording.keyframes.${kind}.K${K}.bytesPerAgentHour`] = summarize([perHour(v.keyframeBytes + v.deltaBytes)], "bytes");
    }
  }
  recordResults("node.json", metrics);
  emit(`\nBelief keyframes and deltas per agent-hour (64 m worlds: 16 chunks per map, so a keyframe is small here; see the 1 km² rebuild table for what a large map costs):\n${table(rows)}`);
}, 240_000);

measure_("belief deltas coalesced: what a delta every N ticks would write instead of one at every sync point (20 agents)", () => {
  const TICKS = 1800;
  const profile = profileWith("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: 60 } }, checkpoints: { everyTicks: 100, snapshotEveryS: 3600 } }));
  const m = runMeasured(loadWorld(WORLDS.twenty.doc(), WORLDS.twenty.cfg()), TICKS, profile);
  const frames = m.items.flatMap((i) => (i.type === "frames" ? i.frames : [])).filter((f) => f.kind === "delta");
  const totalChunks = frames.reduce((n, f) => n + f.chunks.length, 0);
  const bytesPerChunk = frames.reduce((n, f) => n + (f.data?.length ?? 0), 0) / Math.max(1, totalChunks);
  const rows: (string | number)[][] = [["delta every", "frames / s (all agents)", "chunks written / s", "bytes / agent-hour", "against every tick"]];
  let everyTick = 0;
  for (const n of [1, 5, 10, 20, 50]) {
    // Per agent and window of n ticks, a chunk that changed at any sync point of the window is written once, as it is at the end of the window.
    const windows = new Map<string, Set<number>>();
    for (const f of frames) {
      const key = `${f.agentId}:${Math.floor((f.tick - 1) / n)}`;
      const set = windows.get(key) ?? new Set<number>();
      for (const c of f.chunks) set.add(c);
      windows.set(key, set);
    }
    const chunks = [...windows.values()].reduce((k, set) => k + set.size, 0);
    const bytes = chunks * bytesPerChunk;
    if (n === 1) everyTick = bytes;
    rows.push([`${n} tick${n === 1 ? "" : "s"} (${(n * DT).toFixed(1)} s)`, (windows.size / m.simSeconds).toFixed(1), (chunks / m.simSeconds).toFixed(1), kb((bytes / m.agents) * (3600 / m.simSeconds)), `${((bytes / everyTick) * 100).toFixed(0)} %`]);
  }
  emit(`
Belief deltas coalesced (${WORLDS.twenty.label}, ${TICKS * DT} s, ${bytesPerChunk.toFixed(0)} B per written chunk):
${table(rows)}`);
  expect(frames.length).toBeGreaterThan(100);
}, 240_000);

measure_("worst-case rebuild of a belief map at a tick on a fully observed 1 km² map: keyframe plus the longest run of cell deltas K allows", () => {
  const rows: (string | number)[][] = [["map", "keyframe bytes", "deltas", "chunks per delta", "rebuild median", "rebuild max", "within 100 ms"]];
  const metrics: Record<string, ReturnType<typeof summarize>> = {};
  for (const [label, withHeights] of [["1 km², log-odds only (4 KiB per chunk)", false], ["1 km², heights in every chunk (20 KiB per chunk)", true]] as const) {
    const source = fullMap(withHeights);
    const keyframe = encodeValue(source.snapshot());
    for (const [deltas, c] of [[0, 0], [100, 4], [300, 4], [600, 4], [300, 16], [600, 16]] as const) {
      // A delta as the recording writes it: the cells that changed (about 50 in each of `c` chunks, what the 20-agent run writes), with their heights when the map has them.
      const live = fullMap(withHeights);
      live.trackCellChanges();
      for (let k = 0; k < c * 50; k++) {
        const chunk = ((k % c) * 37) % 1024;
        live.observeFree((chunk % 32) * 64 + ((k * 7) % 64), Math.floor(chunk / 32) * 64 + ((k * 13) % 64), 3);
      }
      const taken = c === 0 ? undefined : live.takeCellDelta();
      const delta = deltas === 0 || !taken ? new Uint8Array(0) : encodeValue(taken.delta);
      const cellsPerDelta = taken?.delta.cells.length ?? 0;
      const times: number[] = [];
      for (let rep = 0; rep < 6; rep++) {
        const t0 = performance.now();
        const map = new BeliefMap(2000, 2000, 64);
        map.restore(decodeValue(keyframe) as BeliefMapSnapshot);
        for (let d = 0; d < deltas; d++) map.applyCellDelta(decodeValue(delta) as BeliefCellDelta);
        if (rep >= 1) times.push(performance.now() - t0);
      }
      const s = summarize(times);
      rows.push([label, mb(keyframe.length), deltas, `${c} chunks, ${cellsPerDelta} cells`, ms(s.median), ms(Math.max(...times)), s.median <= 100 ? "yes" : "NO"]);
      metrics[`recording.rebuild.${withHeights ? "heights" : "logodds"}.d${deltas}.c${c}`] = s;
    }
  }
  recordResults("node.json", metrics);
  emit(`\nWorst-case rebuild (decode + restore + deltas), this machine:\n${table(rows)}`);
}, 240_000);

// ---- 5. snapshot volume with blob sharing -------------------------------------------------------------------------------------------------

measure_("snapshot volume on 20 agents with blob sharing at S of 30, 60 and 120 s, against no sharing", () => {
  const TICKS = 2400;
  const rows: (string | number)[][] = [["S", "snapshots", "container bytes (mean)", "new blob bytes (total)", "with sharing / agent-hour", "no sharing / agent-hour", "encode mean", "encode max"]];
  const metrics: Record<string, ReturnType<typeof summarize>> = {};
  for (const S of [30, 60, 120]) {
    const profile = profileWith("default-research", (p) => ({ ...p, channels: { ...p.channels, beliefs: { level: "chunks", keyframeEveryS: S } }, checkpoints: { everyTicks: 100, snapshotEveryS: S } }));
    const m = runMeasured(loadWorld(WORLDS.twenty.doc(), WORLDS.twenty.cfg()), TICKS, profile);
    const snaps = m.items.filter((i): i is Extract<RecorderItem, { type: "snapshot" }> => i.type === "snapshot");
    const container = snaps.reduce((n, s) => n + s.bytes.length, 0) / snaps.length;
    const newBlobs = snaps.reduce((n, s) => n + s.blobs.reduce((k, b) => k + b.bytes.length, 0), 0);
    const withSharing = container * snaps.length + newBlobs;
    const noSharing = snaps.reduce((n, s) => n + s.bytes.length + readSnapshot(s.bytes).sections.reduce((k, x) => k + x.length, 0), 0);
    const perAgentHour = (b: number) => (b / m.agents) * (3600 / m.simSeconds);
    const enc = summarize(m.snapshotMs);
    rows.push([`${S} s`, snaps.length, kb(container), kb(newBlobs), kb(perAgentHour(withSharing)), kb(perAgentHour(noSharing)), ms(enc.mean), ms(Math.max(...m.snapshotMs))]);
    metrics[`recording.snapshots.S${S}.bytesPerAgentHour`] = summarize([perAgentHour(withSharing)], "bytes");
  }
  recordResults("node.json", metrics);
  emit(`\nSnapshot volume, ${WORLDS.twenty.label}, ${TICKS * DT} s (64 m world: maps are small and change as the agents explore):\n${table(rows)}`);
}, 240_000);

measure_("snapshot of the 1 km² prior-map run: container, belief sections and encode time (the large-map case)", () => {
  const world = loadWorld(f2PriorReferenceScenario(), f2PriorRunConfig(1));
  const target = world.recordingTarget();
  const sizes: [string, number, number, number][] = [];
  const scheduler = new Scheduler(world, world.dtS);
  for (const id of world.entityIds) if (id.startsWith("ugv")) world.inject({ agentId: id, name: "explore", params: {} });
  for (const at of [0, 300]) {
    while (world.tick < at) scheduler.step();
    const sections = new Map<string, Uint8Array>();
    const t0 = performance.now();
    const bytes = snapshotRun(target.run, { external: (id, b) => sections.set(id, b) });
    const t = performance.now() - t0;
    sizes.push([`tick ${at}`, bytes.length, [...sections.values()].reduce((n, b) => n + b.length, 0), t]);
  }
  emit(`\n1 km² prior-map run (${world.entityIds.length} agents): ${sizes.map(([l, c, b, t]) => `${l}: container ${kb(c)}, belief sections ${mb(b)}, encode ${ms(t)}`).join("; ")}`);
  recordResults("node.json", { "recording.snapshot.prior1km.encode": summarize(sizes.map((s) => s[3])), "recording.snapshot.prior1km.beliefBytes": summarize(sizes.map((s) => s[2]), "bytes") });
  expect(sizes[0]?.[1]).toBeGreaterThan(0);
}, 240_000);
