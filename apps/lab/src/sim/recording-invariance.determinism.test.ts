import { Scheduler } from "@agentsim/core";
import { F2_DISCOVERY_ID, F2_TWENTY_AGENTS_ID, f2DiscoveryScenario, f2RunConfig, f2TwentyAgentsScenario } from "@agentsim/scenarios";
import { RECORDING_PRESETS, RunRecorder, type RecordingProfile, type TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { ScenarioHostedWorld } from "./hosted-world.ts";
import { RunRecording } from "./run-recording.ts";

// F3a M2 (ADR-0035 §2 and addition of 2026-10-17, item 6): a recording profile is observation only. The same scenario, run configuration and
// seed in lockstep give the same state hash at every tick, and so at every checkpoint, under `minimal` and under `debug-full`, and in a run
// that is not recorded at all. What a profile changes is what is written, never what happens.

type Profile = RecordingProfile | undefined; // undefined: not recorded

interface Arm {
  readonly hashes: string[];
  readonly records: TraceRecord[];
  readonly written: number;
}

function load(scenario: unknown, runConfig: unknown) {
  const loaded = ScenarioHostedWorld.load({ runId: "run-000001", scenario, scenarioVersion: 1, runConfig }, () => 0);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

/** Runs `ticks` ticks (every ground vehicle explores from tick 1), recording under `profile` the way the sim worker does, and returns the hash of every tick. */
function runArm(scenario: unknown, runConfig: unknown, ticks: number, profile: Profile): Arm {
  const world = load(scenario, runConfig);
  const written: TraceRecord[] = [];
  const checkpoints: TraceRecord[] = [];
  let recorder: RunRecorder | undefined;
  if (profile) {
    recorder = new RunRecorder({ buffer: world.trace, profile, send: (b) => written.push(...b.records), sendItem: () => {} });
    const recording = new RunRecording(world.recordingTarget(), recorder, profile);
    world.setTickHook(() => recording.afterTick());
    recording.start();
    recorder.headerStored();
  }
  for (const id of world.entityIds) if (id.startsWith("ugv")) world.inject({ agentId: id, name: "explore", params: {} });
  const scheduler = new Scheduler(world, world.dtS);
  const hashes: string[] = [];
  for (let t = 1; t <= ticks; t++) {
    scheduler.step();
    hashes.push(world.stateHash);
    if (t % 8 === 0) recorder?.collect(world.tick, world.simTimeS);
  }
  recorder?.collect(world.tick, world.simTimeS);
  checkpoints.push(...written.filter((r) => (r.payload as { op?: string } | undefined)?.op === "checkpoint"));
  return { hashes, records: checkpoints, written: written.length };
}

describe("a recording profile never changes the run", () => {
  const scenarios = [
    { name: "F2 discovery (unknown maps, explore)", doc: () => f2DiscoveryScenario(), cfg: () => f2RunConfig(F2_DISCOVERY_ID, 1), ticks: 1500 },
    { name: "F2 20 agents", doc: () => f2TwentyAgentsScenario(), cfg: () => f2RunConfig(F2_TWENTY_AGENTS_ID, 1), ticks: 700 },
  ];

  for (const s of scenarios) {
    it(`${s.name}: the same state hash at every tick under minimal, debug-full and no recording`, () => {
      const minimal = runArm(s.doc(), s.cfg(), s.ticks, RECORDING_PRESETS.minimal);
      const full = runArm(s.doc(), s.cfg(), s.ticks, RECORDING_PRESETS["debug-full"]);
      const none = runArm(s.doc(), s.cfg(), s.ticks, undefined);
      expect(new Set(none.hashes).size).toBeGreaterThan(s.ticks / 2); // the runs do move
      expect(minimal.hashes).toEqual(none.hashes);
      expect(full.hashes).toEqual(none.hashes);
      // They wrote different amounts: the profile did change what is stored.
      expect(full.written).toBeGreaterThan(minimal.written);
      expect(none.written).toBe(0);
    });

    it(`${s.name}: every checkpoint record carries the hash of its tick, whichever the profile`, () => {
      const minimal = runArm(s.doc(), s.cfg(), s.ticks, RECORDING_PRESETS.minimal);
      const full = runArm(s.doc(), s.cfg(), s.ticks, RECORDING_PRESETS["debug-full"]);
      const none = runArm(s.doc(), s.cfg(), s.ticks, undefined);
      for (const arm of [minimal, full]) {
        const cps = arm.records.map((r) => r.payload as { tick: number; stateHash: string });
        expect(cps.length).toBeGreaterThanOrEqual(Math.floor(s.ticks / 100));
        for (const c of cps) if (c.tick > 0) expect(c.stateHash, `tick ${c.tick}`).toBe(none.hashes[c.tick - 1]);
      }
      const at = (arm: Arm) => arm.records.map((r) => (r.payload as { tick: number; stateHash: string }).tick + ":" + (r.payload as { stateHash: string }).stateHash);
      // Under both profiles the checkpoints are at the same ticks with the same hashes (every N ticks and at the first tick).
      const common = at(minimal).filter((x) => at(full).includes(x));
      expect(common.length).toBeGreaterThanOrEqual(Math.floor(s.ticks / 100));
    });
  }
});
