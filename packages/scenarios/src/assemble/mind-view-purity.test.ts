import { runLockstep, type Brain, type DecisionEnvelope, type DecisionRequest } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";

/** Records every request; explores when idle, so events, frontiers and beliefs all appear. */
class Explorer implements Brain {
  readonly requests: DecisionRequest[] = [];
  readonly tier = "baseline" as const;
  constructor(readonly id: string) {}
  decide(req: DecisionRequest): Promise<DecisionEnvelope> {
    this.requests.push(req);
    return Promise.resolve({ decision: req.self.running === null ? { kind: "action", name: "explore", params: {} } : { kind: "idle" } });
  }
}

const make = () => {
  const minds = { rover: new Explorer("m-rover"), low: new Explorer("m-low"), scout: new Explorer("m-scout") };
  const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" } } }, scripts: {}, brains: minds, beliefVsTruth: { everyS: 10 }, objects: [{ id: "marker-1", kind: "marker", position: { xM: 14, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } }] });
  return { run, minds };
};

/**
 * Building the mind view for the Inspector is pure (ADR-0005 addition of 2026-10-12): the same run with the request of
 * every agent peeked at every tick and never peeked at has identical state hashes, traces and mind requests.
 */
async function runOnce(peek: boolean, observe = false, overlays = false) {
  const { run, minds } = make();
  const rover = run.agents.find((a) => a.key === "rover") ?? (run.agents[0] as (typeof run.agents)[number]);
  const raysSeen: number[] = [];
  const hashes: string[] = [];
  for (let t = 0; t < 200; t++) {
    await runLockstep(run.world, run.scheduler, 1);
    if (peek) for (const a of run.agents) run.world.peekRequest(a.id);
    // The researcher stream: the observer's report of every agent at every tick (what a watching panel asks for).
    if (observe) for (const a of run.agents) run.observer?.report(a.id, run.world.tick, run.world.simTimeS);
    // The Scene's overlays: the ray recorder on one agent and the topology reads of every agent, at every tick.
    if (overlays) {
      if (t === 0) run.sensing.watchRays(rover.id);
      const r = run.sensing.takeRays();
      if (r) raysSeen.push(r.segments.length / 4);
      for (const a of run.agents) run.topology.overlay(a.id);
    }
    hashes.push(run.world.stateHash);
  }
  const sensing = run.agents.map((a) => `${a.id}:${run.sensing.beliefHash(a.id)}:${JSON.stringify([...run.sensing.entities(a.id)])}`);
  return { hashes, sensing, raysSeen, trace: run.trace.all().map((r) => ({ ...r, wallTime: 0 })), requests: [...minds.rover.requests, ...minds.low.requests, ...minds.scout.requests] };
}

describe("the Inspector's mind view is observationally pure", () => {
  it("peeked at every tick vs never: identical state hashes, traces and requests received by the minds", async () => {
    const peeked = await runOnce(true);
    const quiet = await runOnce(false);
    expect(peeked.hashes).toEqual(quiet.hashes);
    expect(peeked.trace).toEqual(quiet.trace);
    expect(JSON.stringify(peeked.requests)).toBe(JSON.stringify(quiet.requests));
    expect(quiet.requests.length).toBeGreaterThan(3);
  });

  it("the researcher stream is pure too: the observer's report asked for at every tick vs never: identical hashes, traces and requests", async () => {
    const watched = await runOnce(false, true);
    const quiet = await runOnce(false);
    expect(watched.hashes).toEqual(quiet.hashes);
    expect(watched.trace).toEqual(quiet.trace);
    expect(JSON.stringify(watched.requests)).toBe(JSON.stringify(quiet.requests));
  });

  it("the ray recorder and the topology overlay reads are observation-only: on vs off gives identical hashes, traces, requests and sensing results", async () => {
    const watched = await runOnce(false, false, true);
    const quiet = await runOnce(false);
    expect(watched.hashes).toEqual(quiet.hashes);
    expect(watched.trace).toEqual(quiet.trace);
    expect(watched.sensing).toEqual(quiet.sensing); // belief maps and entity beliefs of every agent
    expect(JSON.stringify(watched.requests)).toBe(JSON.stringify(quiet.requests));
    // It recorded the viewed agent's lidar, decimated to at most 64 rays per reading, and only on new readings.
    expect(watched.raysSeen.length).toBeGreaterThan(50);
    expect(Math.max(...watched.raysSeen)).toBeLessThanOrEqual(64);
    expect(Math.min(...watched.raysSeen)).toBeGreaterThan(0);
    expect(quiet.raysSeen).toEqual([]);
  });

  it("records nothing when nobody is watched, and nothing for any agent but the watched one", async () => {
    const { run } = make();
    await runLockstep(run.world, run.scheduler, 20);
    expect(run.sensing.takeRays()).toBeUndefined();
    const other = run.agents.find((a) => a.key === "low")?.id ?? "";
    run.sensing.watchRays(other);
    await runLockstep(run.world, run.scheduler, 20);
    const r = run.sensing.takeRays();
    expect(r?.segments.length).toBeGreaterThan(0);
    // Every ray starts at the watched agent's position (not another agent's).
    const a = run.agents.find((x) => x.id === other);
    expect(r?.segments[0]).toBeCloseTo(a?.state.x ?? NaN, 3);
    expect(run.sensing.takeRays()).toBeUndefined(); // handed out once per reading
    run.sensing.watchRays(null);
    await runLockstep(run.world, run.scheduler, 20);
    expect(run.sensing.takeRays()).toBeUndefined();
  });

  it("is the world's own builder: the pending request is the one the mind was asked, and the next one differs only by the events it consumed", async () => {
    const { run, minds } = make();
    const id = run.agents.find((a) => a.key === "rover")?.id ?? "";
    let checked = 0;
    for (let t = 0; t < 80 && checked < 3; t++) {
      await run.world.decide().catch(() => undefined);
      run.world.step({ tick: run.world.tick + 1, simTimeS: (run.world.tick + 1) * 0.1, dtS: 0.1 });
      const open = run.world.outstanding.find((r) => r.agentId === id);
      if (!open) continue;
      const before = run.world.peekRequest(id);
      expect(before?.pending).toBe(true);
      expect(JSON.stringify(before?.request)).toBe(JSON.stringify(open)); // the request the mind is being asked
      await run.world.decide(); // answered, not yet applied: no longer pending, state unchanged
      const after = run.world.peekRequest(id);
      expect(after?.pending).toBe(false);
      expect(JSON.stringify({ ...after?.request, events: [], eventsDropped: 0 })).toBe(JSON.stringify({ ...open, events: [], eventsDropped: 0 }));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(minds.rover.requests.length).toBeGreaterThan(0);
  });

  it("peeks are repeatable (the same request every time) and an unknown agent has none", async () => {
    const { run } = make();
    const id = run.agents.find((a) => a.key === "rover")?.id ?? "";
    await runLockstep(run.world, run.scheduler, 1);
    const a = run.world.peekRequest(id)?.request;
    const b = run.world.peekRequest(id)?.request;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(run.world.peekRequest("ugv-099")).toBeUndefined();
  });
});
