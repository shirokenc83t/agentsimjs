import { runLockstep } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";

const payload = (r: TraceRecord) => (r.payload ?? {}) as Record<string, unknown>;
const injected = (run: ReturnType<typeof buildReferenceRun>, agentId: string) => run.trace.all().filter((r) => r.kind === "injected" && r.agentId === agentId).map(payload);

describe("researcher commands: the closed set (ADR-0015 addition of 2026-10-12)", () => {
  it("goTo, takeoff, land, explore and hold start through the normal checks; anything else is not injectable", async () => {
    const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } } }, scripts: {} });
    await runLockstep(run.world, run.scheduler, 3);
    run.world.inject({ agentId: "uav-001", name: "takeoff", params: { altitudeM: 15 } });
    run.world.inject({ agentId: "ugv-001", name: "explore", params: {} });
    run.world.inject({ agentId: "ugv-002", name: "hold", params: { durationS: 5 } });
    run.world.inject({ agentId: "ugv-002", name: "returnToBase", params: {} });
    await runLockstep(run.world, run.scheduler, 5);
    expect(injected(run, "uav-001")).toEqual([expect.objectContaining({ op: "command", name: "takeoff", ok: true })]);
    expect(injected(run, "ugv-001")).toEqual([expect.objectContaining({ name: "explore", ok: true })]);
    const low = injected(run, "ugv-002");
    expect(low[0]).toMatchObject({ name: "hold", ok: true });
    expect(low[1]).toMatchObject({ name: "returnToBase", ok: false, failure: "not_injectable" });
    // A timer is not an action and is not injectable either.
    run.world.inject({ agentId: "ugv-001", name: "setTimer", params: { delayS: 1, tag: "t" } });
    await runLockstep(run.world, run.scheduler, 2);
    expect(injected(run, "ugv-001").at(-1)).toMatchObject({ name: "setTimer", ok: false });
  });

  it("world scope bypasses the scope check, never the preconditions: a goTo on a grounded UAV is refused with precondition_failed", async () => {
    const run = buildReferenceRun({ scripts: {} });
    await runLockstep(run.world, run.scheduler, 3);
    run.world.inject({ agentId: "uav-001", name: "goTo", params: { xM: 20, yM: 20, altitudeM: 20 } });
    await runLockstep(run.world, run.scheduler, 3);
    expect(injected(run, "uav-001")).toEqual([expect.objectContaining({ name: "goTo", ok: false, failure: "precondition_failed", requires: "airborne", message: expect.stringContaining("airborne") })]); // the record says which precondition, for the words shown to the researcher
    // After a takeoff the same command is accepted.
    run.world.inject({ agentId: "uav-001", name: "takeoff", params: { altitudeM: 20 } });
    await runLockstep(run.world, run.scheduler, 200);
    run.world.inject({ agentId: "uav-001", name: "goTo", params: { xM: 20, yM: 20, altitudeM: 20 } });
    await runLockstep(run.world, run.scheduler, 3);
    expect(injected(run, "uav-001").at(-1)).toMatchObject({ name: "goTo", ok: true });
  });

  it("each command is recorded as a run input and replaying the inputs reproduces the run (same state hash at every checkpoint)", async () => {
    const mk = () => buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } } }, scripts: {} });
    const live = mk();
    const live1: string[] = [];
    for (let k = 0; k < 12; k++) {
      await runLockstep(live.world, live.scheduler, 25);
      if (k === 1) live.world.inject({ agentId: "uav-001", name: "takeoff", params: { altitudeM: 15 } });
      if (k === 2) live.world.inject({ agentId: "ugv-001", name: "explore", params: {} });
      if (k === 4) live.world.inject({ agentId: "ugv-002", name: "hold", params: { durationS: 3 } });
      if (k === 6) live.world.inject({ agentId: "uav-001", name: "goTo", params: { xM: 20, yM: 30, altitudeM: 15 } });
      if (k === 9) live.world.inject({ agentId: "uav-001", name: "land", params: {} });
      live1.push(live.world.stateHash);
    }
    expect(live.world.inputs.map((i) => i.name)).toEqual(["takeoff", "explore", "hold", "goTo", "land"]);
    const replay = mk();
    for (const i of live.world.inputs) replay.world.inject({ agentId: i.agentId, name: i.name, params: i.params }, i.tick);
    const replayed: string[] = [];
    for (let k = 0; k < 12; k++) {
      await runLockstep(replay.world, replay.scheduler, 25);
      replayed.push(replay.world.stateHash);
    }
    expect(replayed).toEqual(live1);
  });
});
