import { createMemoryPorts, type StoragePorts } from "@agentsim/storage";
import { f2DiscoveryScenario } from "@agentsim/scenarios";
import { recordingProfileHash, type TraceRecord } from "@agentsim/trace";
import { beliefAt, world } from "../workers/replay-module.ts";
import type { CursorPort } from "./replay-run-source.ts";
import { latestPlans } from "./run-source.ts";
import { profileOf, setup } from "./run-recording-harness.ts";

// Shared by the tests of replay: the scenario a recorded test run is made from, a recorded run in memory ports, a cursor, the storage worker's replay reads called
// in place, and the planned paths a trace says.

export { f2DiscoveryScenario };

/** The latest found plan per agent of some records, as the Scene draws planned paths. */
export const latestPlansOfRecords = (records: readonly TraceRecord[]) => latestPlans(records);

export function cursorPort() {
  let value = 0;
  const listeners = new Set<() => void>();
  const port: CursorPort = { get: () => value, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) };
  return {
    port,
    set(v: number) {
      value = v;
      for (const l of listeners) l();
    },
    count: () => listeners.size,
  };
}

/** The storage worker's replay reads, called in place over the same ports. */
export const replayOver = (ports: StoragePorts) => ({ beliefAt: (r: string, a: string, t: number, v?: Parameters<typeof beliefAt>[4]) => beliefAt(ports, r, a, t, v), world: (r: string) => world(ports, r) });

export interface Live {
  readonly at: Map<number, Map<string, { x: number; y: number; z: number; heading: number; soc: number }>>;
}

export async function recorded(ticks: number, edit?: (records: TraceRecord[]) => TraceRecord[]) {
  const profile = profileOf("default-research", (p) => ({ ...p, channels: { ...p.channels, poses: { rateHz: 10 }, beliefs: { level: "chunks", keyframeEveryS: 6 } } }));
  const t = setup(profile);
  t.explore(t.driver);
  const agents = t.world.recordingTarget().run.agents;
  const live: Live = { at: new Map() };
  const grab = (tick: number) =>
    live.at.set(tick, new Map(agents.map((a) => [a.id, { x: a.state.x, y: a.state.y, z: a.kind === "uav" ? a.state.z : 0, heading: a.state.heading, soc: a.battery.soc }])));
  grab(0);
  for (let i = 1; i <= ticks; i++) {
    t.step(1);
    grab(i);
  }
  const ports = createMemoryPorts();
  const saved = await ports.scenarios.saveVersion(f2DiscoveryScenario());
  if (!saved.ok) throw new Error(saved.error.message);
  await ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "completed", recording: "stored", recordingProfile: profile, recordingProfileHash: recordingProfileHash(profile), scenarioId: saved.value.id, scenarioVersion: saved.value.version });
  for (const item of t.items) {
    if (item.type === "snapshot") await ports.snapshots.write(item.runId, { seq: item.seq, simTime: item.simTimeS, tick: item.tick, bytes: item.bytes, blobs: item.blobs });
    else if (item.type === "metrics") await ports.metrics.append(item.runId, item.samples);
    else {
      await ports.snapshots.putBlobs(item.runId, item.blobs);
      await ports.beliefFrames.append(item.runId, item.frames);
    }
  }
  const records = edit ? edit(t.records()) : t.records();
  const appended = await ports.trace.append(records);
  if (!appended.ok) throw new Error(appended.error.message);
  return { t, ports, live, profile };
}

