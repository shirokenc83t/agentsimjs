import { Scheduler } from "@agentsim/core";
import { F2_DISCOVERY_ID, f2DiscoveryScenario, f2RunConfig } from "@agentsim/scenarios";
import { RECORDING_PRESETS, RunRecorder, type RecorderBatch, type RecorderItem, type RecordingProfile, type TraceRecord } from "@agentsim/trace";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { RunRecording } from "./run-recording.ts";

// Shared by the tests of what a recorded run writes: a recorded F2 discovery run (unknown maps, agents that explore), stepped by hand.

export const profileOf = (name: keyof typeof RECORDING_PRESETS, edit: (p: RecordingProfile) => RecordingProfile = (p) => p): RecordingProfile => edit(JSON.parse(JSON.stringify(RECORDING_PRESETS[name])) as RecordingProfile);

export function setup(profile = RECORDING_PRESETS["default-research"], load: { runConfig?: unknown } = {}) {
  const loaded = ScenarioHostedWorld.load({ runId: "run-000001", scenario: f2DiscoveryScenario(), scenarioVersion: 1, runConfig: load.runConfig ?? f2RunConfig(F2_DISCOVERY_ID, 1) }, () => 0);
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
  const step = (n: number) => {
    for (let i = 0; i < n; i++) scheduler.step();
    recorder.collect(world.tick, world.simTimeS);
  };
  const driver = world.entityIds.find((id) => id.startsWith("ugv")) ?? "";
  const explore = (agentId = driver) => world.inject({ agentId, name: "explore", params: {} });
  const records = (): TraceRecord[] => batches.flatMap((b) => b.records);
  const op = (r: TraceRecord) => (r.payload as { op?: string } | undefined)?.op;
  return { world, recorder, recording, step, explore, driver, batches, items, records, op, scheduler };
}

export const snapshotsOf = (items: RecorderItem[]) => items.filter((i): i is Extract<RecorderItem, { type: "snapshot" }> => i.type === "snapshot");
export const framesOf = (items: RecorderItem[]) => items.filter((i): i is Extract<RecorderItem, { type: "frames" }> => i.type === "frames").flatMap((i) => i.frames);

