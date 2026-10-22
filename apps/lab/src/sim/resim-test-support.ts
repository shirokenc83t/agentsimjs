import { createMemoryPorts, type StoragePorts, type StoredRunInput } from "@agentsim/storage";
import { Scheduler } from "@agentsim/core";
import { F2_DISCOVERY_ID, F2_TWENTY_AGENTS_ID, f2DiscoveryScenario, f2RunConfig, f2TwentyAgentsScenario } from "@agentsim/scenarios";
import { RunRecorder, recordingProfileHash, type RecorderBatch, type RecorderItem, type RecordingProfile, type TraceRecord } from "@agentsim/trace";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { RunRecording } from "./run-recording.ts";
import type { RecordedCheckpoint } from "./resim-window.ts";
import { profileOf } from "./run-recording-harness.ts";

// A recorded parent run for the tests of re-simulation: an F2 discovery run (unknown maps, a rover that explores) recorded under a profile with a snapshot every
// 2 s and a checkpoint every 5 ticks, in memory ports as the lab stores it, with what a re-simulation reads of it.

export const PARENT_PROFILE = (): RecordingProfile => profileOf("default-research", (p) => ({ ...p, checkpoints: { everyTicks: 5, snapshotEveryS: 2 } }));

export type ParentScenario = "discovery" | "twenty-agents";

export async function recordedParent(ticks: number, opts: { profile?: RecordingProfile; explore?: boolean; scenario?: ParentScenario; storeInputs?: boolean } = {}) {
  const profile = opts.profile ?? PARENT_PROFILE();
  const twenty = opts.scenario === "twenty-agents";
  const scenario = twenty ? f2TwentyAgentsScenario() : f2DiscoveryScenario();
  const runConfig = f2RunConfig(twenty ? F2_TWENTY_AGENTS_ID : F2_DISCOVERY_ID, 1);
  const loaded = ScenarioHostedWorld.load({ runId: "run-000001", scenario, scenarioVersion: 1, runConfig }, () => 0);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const world = loaded.value;
  const batches: RecorderBatch[] = [];
  const items: RecorderItem[] = [];
  const recorder = new RunRecorder({ buffer: world.trace, profile, send: (b) => batches.push(b), sendItem: (i) => items.push(i) });
  const recording = new RunRecording(world.recordingTarget(), recorder, profile);
  world.setTickHook(() => recording.afterTick());
  const scheduler = new Scheduler(world, world.dtS);
  recording.start();
  recorder.headerStored();
  if (opts.explore !== false) {
    // Every ground agent explores (the first at once, the others a little later, so the run inputs are several, at several ticks).
    const ground = world.entityIds.filter((id) => id.startsWith("ugv"));
    scheduler.step();
    recorder.collect(world.tick, world.simTimeS);
    ground.forEach((id, k) => {
      const r = world.inject({ agentId: id, name: "explore", params: {} }, world.tick + 1 + k * 3);
      if (!r.ok) throw new Error(r.error.message);
    });
  }
  while (world.tick < ticks) {
    scheduler.step();
    recorder.collect(world.tick, world.simTimeS);
  }
  recording.end();
  recorder.collect(world.tick, world.simTimeS);
  const t = { world, items, records: () => batches.flatMap((b) => b.records) };
  const ports = createMemoryPorts();
  const saved = await ports.scenarios.saveVersion(scenario);
  if (!saved.ok) throw new Error(saved.error.message);
  const created = await ports.runs.create({
    runId: "run-000001",
    schemaVersion: 0,
    createdAtWallMs: 1,
    label: "parent",
    status: "completed",
    recording: "stored",
    recordingProfile: profile,
    recordingProfileHash: recordingProfileHash(profile),
    scenarioId: saved.value.id,
    scenarioVersion: saved.value.version,
    runConfig,
    runConfigHash: world.loaded.runConfigHash,
    effectiveConfigHash: world.loaded.effectiveConfigHash,
  });
  if (!created.ok) throw new Error(created.error.message);
  const blobs = new Map<string, Uint8Array>();
  const snapshots: { tick: number; bytes: Uint8Array }[] = [];
  for (const item of t.items) {
    if (item.type === "snapshot") {
      snapshots.push({ tick: item.tick, bytes: item.bytes });
      for (const b of item.blobs) blobs.set(b.id, b.bytes);
      await ports.snapshots.write(item.runId, { seq: item.seq, simTime: item.simTimeS, tick: item.tick, bytes: item.bytes, blobs: item.blobs });
    } else if (item.type === "metrics") {
      await ports.metrics.append(item.runId, item.samples);
    } else {
      for (const b of item.blobs) blobs.set(b.id, b.bytes);
      await ports.snapshots.putBlobs(item.runId, item.blobs);
      await ports.beliefFrames.append(item.runId, item.frames);
    }
  }
  const records = t.records();
  const appended = await ports.trace.append(records);
  if (!appended.ok) throw new Error(appended.error.message);
  const inputs: StoredRunInput[] = t.world.inputs.map((i) => ({ inputId: i.inputId, tick: i.tick, agentId: i.agentId, name: i.name, params: i.params }));
  // A run whose inputs were not kept (the test of a window that cannot be reproduced) has none in storage; the ones it ran are still in `inputs`.
  const stored = opts.storeInputs === false ? { ok: true as const } : await ports.runs.appendInputs("run-000001", inputs);
  if (!stored.ok) throw new Error(stored.error.message);
  return { t, ports, profile, records, inputs, snapshots, blobs, scenario, version: saved.value.version, runConfig };
}

/** The parent's checkpoints, as its records say them. */
export function checkpointsOf(records: readonly TraceRecord[]): RecordedCheckpoint[] {
  return records.flatMap((r) => {
    const p = r.payload as { op?: string; tick?: number; stateHash?: string } | undefined;
    return r.kind === "event" && p?.op === "checkpoint" && typeof p.tick === "number" && typeof p.stateHash === "string" ? [{ tick: p.tick, stateHash: p.stateHash }] : [];
  });
}

export type Parent = Awaited<ReturnType<typeof recordedParent>>;
export type { StoragePorts };
