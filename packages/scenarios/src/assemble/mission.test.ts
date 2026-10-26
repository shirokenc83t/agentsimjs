import { runLockstep, type SequenceStep } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../load.ts";
import { f2DiscoveryScenario, f2RunConfig, F2_DISCOVERY_ID } from "../presets/f2-presets.ts";
import { canonicalRunConfig, effectiveConfigHash, resolveRunConfig } from "../run-config/resolve.ts";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun } from "../testing/preset-run.ts";
import { restoreRun, snapshotRun } from "./snapshot-run.ts";

// F3c M1: a mission is the `sequence` script mind in the run configuration (ADR-0036 addition of 2026-10-26): take off, go to a point, explore a bounded radius, return home, land, on
// the F2 scene, for its UAV (`scout`). A UAV that returns to base lands there (the action says so), so the mission ends at `returnToBase`: a `land` after it is refused (it needs airborne). Everything below is a property of the run: a mission that ends, hashes that do not move, a chain of records, a stop with its reason.

const MISSION: SequenceStep[] = [
  { action: "takeoff", args: { altitudeM: 20 } },
  { action: "goTo", args: { xM: 50, yM: 20 } },
  { action: "explore", args: { radiusM: 12 } },
  { action: "returnToBase" },
];

const withMission = (steps: readonly SequenceStep[]): Partial<RunConfigDocument> =>
  ({ minds: { byAgent: { scout: { s1: { script: { name: "sequence", params: { steps } } } } } } }) as unknown as Partial<RunConfigDocument>;

const payloadOf = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
const mine = (run: ReturnType<typeof buildPresetRun>) => run.trace.all().filter((r) => r.agentId === "uav-001");
const decisions = (run: ReturnType<typeof buildPresetRun>) => mine(run).filter((r) => r.kind === "thought" && payloadOf(r).op === "decision");
const starts = (run: ReturnType<typeof buildPresetRun>) => mine(run).filter((r) => r.kind === "action" && payloadOf(r).op === "start");
const ends = (run: ReturnType<typeof buildPresetRun>) => mine(run).filter((r) => r.kind === "action" && payloadOf(r).op === "end");

/** Steps the run until the mission's mind says it ended (or `maxTicks`), the way the lab's run would go on. */
async function runMission(run: ReturnType<typeof buildPresetRun>, maxTicks = 9000): Promise<void> {
  for (let t = 0; t < maxTicks; t += 10) {
    await runLockstep(run.world, run.scheduler, 10);
    if (decisions(run).some((d) => payloadOf(d).done === true || payloadOf(d).stop !== undefined)) return;
  }
  throw new Error("the mission did not end");
}

describe("a mission on the F2 scene", () => {
  it("take off → go to a point → explore → return home (which lands a UAV) runs to the end, each step done, in order", async () => {
    const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission(MISSION) });
    await runMission(run);
    expect(starts(run).map((r) => payloadOf(r).name)).toEqual(["takeoff", "goTo", "explore", "returnToBase"]);
    expect(ends(run).map((r) => [payloadOf(r).name, payloadOf(r).status])).toEqual([
      ["takeoff", "succeeded"],
      ["goTo", "succeeded"],
      ["explore", "succeeded"],
      ["returnToBase", "succeeded"],
    ]);
    const last = decisions(run).at(-1);
    expect(payloadOf(last as TraceRecord)).toMatchObject({ step: 4, of: 4, done: true });
  });

  it("is deterministic: the same configuration gives the same state hash at every checkpoint, and the same trace", async () => {
    const hashes: string[][] = [];
    const digests: string[] = [];
    for (let k = 0; k < 2; k++) {
      const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission(MISSION) });
      const h: string[] = [];
      for (let i = 0; i < 12; i++) {
        await runLockstep(run.world, run.scheduler, 100);
        h.push(run.world.stateHash);
      }
      hashes.push(h);
      digests.push(JSON.stringify(mine(run).map((r) => [r.seq, r.kind, r.simTime, r.parentId ?? null, r.causeIds ?? null, r.payload])));
    }
    expect(hashes[1]).toEqual(hashes[0]);
    expect(digests[1]).toBe(digests[0]);
  });

  it("reads as decision → start → steps: each start names its decision as its cause, and what happens during the action belongs to its start", async () => {
    const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission(MISSION) });
    await runMission(run);
    const byId = new Map(run.trace.all().map((r) => [r.id, r]));
    const starting = decisions(run).filter((d) => payloadOf(d).step !== undefined && payloadOf(d).stop === undefined && payloadOf(d).done === undefined);
    expect(starting).toHaveLength(4);
    expect(starting.map((d) => [payloadOf(d).step, payloadOf(d).of])).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    for (const s of starts(run)) {
      const cause = s.causeIds?.map((id) => byId.get(id)).find((r) => r?.kind === "thought" && payloadOf(r).op === "decision");
      expect(cause, `the start ${s.id} names a decision`).toBeDefined();
      expect(payloadOf(cause as TraceRecord).decision).toMatchObject({ kind: "action", name: payloadOf(s).name });
    }
    // The third level: the records of an action's life name its start as their parent (goTo has legs and phases).
    const goToStart = starts(run).find((r) => payloadOf(r).name === "goTo") as TraceRecord;
    expect(run.trace.all().some((r) => r.parentId === goToStart.id)).toBe(true);
  });

  it("stops at a refused step with its index and reason, and starts nothing after it (a mission that explores before it has taken off)", async () => {
    const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission([{ action: "explore" }, { action: "takeoff", args: { altitudeM: 20 } }]) });
    await runMission(run);
    expect(starts(run).map((r) => payloadOf(r).name)).not.toContain("takeoff");
    const stop = decisions(run).find((d) => payloadOf(d).stop !== undefined) as TraceRecord;
    expect(payloadOf(stop)).toMatchObject({ step: 1, of: 2, stop: { status: "refused", action: "explore", code: "precondition_failed" } });
    expect(String(payloadOf(stop).rationale)).toContain("explore");
    // It stays stopped: more ticks start nothing.
    await runLockstep(run.world, run.scheduler, 300);
    expect(starts(run).map((r) => payloadOf(r).name)).toEqual([]);
  });

  it("refuses a `land` after `returnToBase`: the UAV landed at its base, and `land` needs it airborne (the start check says so, the mission stops there)", async () => {
    const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission([...MISSION, { action: "land" }]) });
    await runMission(run);
    const stop = decisions(run).find((d) => payloadOf(d).stop !== undefined) as TraceRecord;
    expect(payloadOf(stop)).toMatchObject({ step: 5, of: 5, stop: { status: "refused", action: "land", code: "precondition_failed" } });
    expect(ends(run).map((r) => payloadOf(r).name)).toEqual(["takeoff", "goTo", "explore", "returnToBase"]);
  });

  it("shows a reflex during a step and stops there: the battery reflex takes the agent home, the step ends preempted and the mission does not resume", async () => {
    const run = buildPresetRun({
      preset: "f2-discovery",
      scripts: {},
      runConfig: withMission([{ action: "takeoff", args: { altitudeM: 20 } }, { action: "explore", args: { radiusM: 40 } }, { action: "land" }]),
      bodies: { scout: { battery: { initialSoc: 0.16, criticalSoc: 0.15 } } },
    });
    await runMission(run, 6000);
    expect(mine(run).some((r) => r.kind === "reflex")).toBe(true);
    const stop = decisions(run).find((d) => payloadOf(d).stop !== undefined) as TraceRecord;
    expect(payloadOf(stop).stop).toMatchObject({ status: "preempted", code: expect.any(String) });
    expect(starts(run).map((r) => payloadOf(r).name)).not.toContain("land");
  });

  it("is refused at load when a step is not valid, naming the step, and is part of the effective configuration (hashed)", () => {
    const loaded = loadScenario(f2DiscoveryScenario());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const resolve = (cfg: Partial<RunConfigDocument>) => resolveRunConfig({ ...f2RunConfig(F2_DISCOVERY_ID, 1), ...cfg }, { loaded: loaded.value, version: 1 });
    const bad = resolve(withMission([{ action: "takeoff", args: { altitudeM: 20 } }, { action: "fly" }]));
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_mission" } });
    expect(!bad.ok && bad.error.message).toContain("step 2");
    expect(!bad.ok && bad.error.path).toContain("/minds/byAgent/scout");
    expect(resolve(withMission([{ action: "goTo", args: { xM: 3 } }]))).toMatchObject({ ok: false, error: { code: "invalid_mission" } });
    expect(resolve(withMission([]))).toMatchObject({ ok: false, error: { code: "invalid_mission" } });
    const rover = resolve({ minds: { byAgent: { rover: { s1: { script: { name: "sequence", params: { steps: [{ action: "takeoff", args: { altitudeM: 20 } }] } } } } } } } as unknown as Partial<RunConfigDocument>);
    expect(rover).toMatchObject({ ok: false, error: { code: "invalid_mission" } }); // a ground vehicle cannot take off
    expect(resolve({ minds: { byAgent: { nobody: { s1: { script: { name: "sequence", params: { steps: [{ action: "hold" }] } } } } } } } as unknown as Partial<RunConfigDocument>)).toMatchObject({ ok: false, error: { code: "unknown_agent_key" } });
    const a = resolve(withMission(MISSION));
    const b = resolve(withMission([...MISSION.slice(0, 3)]));
    const none = resolve({});
    if (!a.ok || !b.ok || !none.ok) throw new Error("resolve");
    expect(a.value.runConfigHash).not.toBe(b.value.runConfigHash);
    expect(a.value.effectiveConfigHash).not.toBe(b.value.effectiveConfigHash);
    expect(a.value.agents.find((x) => x.key === "scout")?.mind).toBeDefined();
    // Without a mission nothing of the configuration changes: the hashes are those of a run with no `minds` at all.
    expect(none.value.agents.every((x) => x.mind === undefined)).toBe(true);
    expect(effectiveConfigHash(none.value.agents)).toBe(none.value.effectiveConfigHash);
    expect(canonicalRunConfig({ ...f2RunConfig(F2_DISCOVERY_ID, 1), minds: {} } as RunConfigDocument)).toBe(canonicalRunConfig(f2RunConfig(F2_DISCOVERY_ID, 1)));
  });

  it("is traced in the agent's config record, so a run that is read back says what its mind was", async () => {
    const run = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission(MISSION) });
    const config = run.trace.all().find((r) => r.agentId === "uav-001" && payloadOf(r).op === "config") as TraceRecord;
    expect(payloadOf(config).mind).toEqual({ s1: { script: { name: "sequence", params: { steps: MISSION } } } });
    const other = run.trace.all().find((r) => r.agentId === "ugv-001" && payloadOf(r).op === "config") as TraceRecord;
    expect("mind" in payloadOf(other)).toBe(false);
  });

  it("re-simulates by window: a snapshot taken while a step runs, restored into a fresh run, reaches the same hashes, starts the rest of the steps and ends the same", async () => {
    const original = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission(MISSION) });
    const checkpoints = new Map<number, string>();
    let bytes: Uint8Array | undefined;
    let snapTick = 0;
    for (let t = 0; t < 9000; t += 100) {
      await runLockstep(original.world, original.scheduler, 100);
      checkpoints.set(original.world.tick, original.world.stateHash);
      // In the third step (explore) the first time the run is seen there: the mind is at step 3 of 4, waiting for it to end.
      if (bytes === undefined && starts(original).length === 3) {
        bytes = snapshotRun(original);
        snapTick = original.world.tick;
      }
      if (decisions(original).some((d) => payloadOf(d).done === true)) break;
    }
    if (!bytes) throw new Error("no snapshot");
    const endTick = original.world.tick;
    expect(snapTick).toBeGreaterThan(0);
    expect(snapTick).toBeLessThan(endTick);
    const fork = buildPresetRun({ preset: "f2-discovery", scripts: {}, runConfig: withMission(MISSION) }, "restore-target");
    restoreRun(fork, bytes);
    expect(fork.world.stateHash).toBe(checkpoints.get(snapTick));
    for (let t = snapTick; t < endTick; t += 100) {
      await runLockstep(fork.world, fork.scheduler, 100);
      expect(fork.world.stateHash, `tick ${fork.world.tick}`).toBe(checkpoints.get(fork.world.tick));
    }
    expect(starts(fork).map((r) => payloadOf(r).name)).toEqual(["returnToBase"]);
    expect(decisions(fork).some((d) => payloadOf(d).done === true)).toBe(true);
  });
});
