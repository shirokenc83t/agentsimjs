import type { SimAgent } from "@agentsim/core";
import { TraceBuffer, type TraceRecord, type Tracer } from "@agentsim/trace";
import { runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun, REFERENCE_DT_S, runReference } from "../testing/reference-run.ts";

/*
 * The long reference runs (full 3,000-tick runs, or long input replays), with sensing on since F2. They run in the
 * `determinism` test project (`pnpm test:determinism`, its own CI job), so `pnpm test` stays fast; nothing is dropped.
 */

function agent(run: ReturnType<typeof buildReferenceRun>, key: string): SimAgent {
  const a = run.agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
}

const payload = (r: TraceRecord) => r.payload as Record<string, unknown>;
/** The trace without wall time (metadata, never compared). */
const strip = (recs: readonly TraceRecord[]) => recs.map(({ wallTime: _w, ...r }) => r);

/** Records only full-detail entries: phase transitions are dropped (a minimal recording). */
class MinimalTraceBuffer extends TraceBuffer {
  dropped_ = 0;
  override for(source: string): Tracer {
    const inner = super.for(source);
    return {
      source,
      append: (r) => {
        if (r.detail === "full") return inner.append(r);
        this.dropped_++;
        return { ...r, source, id: "dropped", runId: this.runId, seq: 0, wallTime: 0 };
      },
    };
  }
}

describe("world loop (F1 d7): full reference runs", () => {
  it("same scenario, run configuration and seed → same state hash at every checkpoint and the same trace", async () => {
    const a = await runReference({ runConfig: { seed: 7 } });
    const b = await runReference({ runConfig: { seed: 7 } });
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(strip(b.run.trace.all())).toEqual(strip(a.run.trace.all()));
    // The run actually did something: the hash changes over time.
    expect(new Set(a.checkpoints).size).toBeGreaterThan(5);
  });

  it("planning caches never change the outcome (ADR-0024)", async () => {
    const cached = await runReference();
    const uncached = await runReference({ planningCachesEnabled: false });
    expect(uncached.checkpoints).toEqual(cached.checkpoints);
  });

  it("preparing planning graphs at load never changes the outcome: same checkpoints and trace as building on first use (ADR-0024)", async () => {
    const hpa = { runConfig: { planning: { default: { algorithm: "hpa" as const } } } };
    const lazy = await runReference(hpa);
    const prepared = await runReference({ ...hpa, preparePlanning: true });
    expect(prepared.run.prepared).toEqual({ views: 2, graphs: 2 }); // the two UGVs share a view; the UAV has its own
    expect(prepared.checkpoints).toEqual(lazy.checkpoints);
    expect(strip(prepared.run.trace.all())).toEqual(strip(lazy.run.trace.all()));
    const planned = prepared.run.trace.all().filter((r) => r.kind === "compute");
    expect(planned.length).toBeGreaterThan(0);
  });

  it("recording detail (minimal vs full trace, or a tiny buffer) never affects the state hash", async () => {
    const full = await runReference();
    const minimal = new MinimalTraceBuffer("run-000001", () => 0, 1_000_000);
    const min = await runReference({ trace: minimal });
    const tiny = await runReference({ trace: new TraceBuffer("run-000001", () => 0, 1) });
    expect(minimal.dropped_).toBeGreaterThan(0);
    expect(min.run.trace.all().length).toBeLessThan(full.run.trace.all().length);
    expect(min.checkpoints).toEqual(full.checkpoints);
    expect(tiny.checkpoints).toEqual(full.checkpoints);
  });

  it("goTo behind obstacles succeeds along a traced planned path; a target in a closed box fails unreachable", async () => {
    const { run } = await runReference();
    const rover = agent(run, "rover");
    const actions = run.trace.all().filter((r) => r.agentId === rover.id && r.kind === "action" && payload(r).op === "end");
    expect(actions.map((r) => [payload(r).name, payload(r).status, (payload(r).failure as { code?: string } | undefined)?.code])).toEqual([
      ["goTo", "succeeded", undefined],
      ["goTo", "failed", "unreachable"],
    ]);
    const plans = run.trace.all().filter((r) => r.agentId === rover.id && r.kind === "compute");
    expect(plans[0]?.source).toBe(`${rover.id}/planner`);
    const path = payload(plans[0] as TraceRecord).waypoints as [number, number][];
    // The planned path goes around the wall's north end (y ≥ 50 when crossing x = 30).
    expect(path.some(([x, y]) => x > 29 && x < 32 && y > 50)).toBe(true);
    // The script was told about both ends, and decisions are traced from the agent's s2 component.
    const thoughts = run.trace.all().filter((r) => r.agentId === rover.id && r.kind === "thought" && payload(r).op === "decision");
    // (Requests for perception events alone, e.g. a camera seeing the other rover, answer idle and are left out.)
    const control = thoughts.filter((r) => (payload(r).events as { kind: string }[]).some((e) => ["start", "actionCompleted", "actionFailed"].includes(e.kind)));
    expect(control.map((r) => (payload(r).events as { kind: string }[]).filter((e) => e.kind !== "detected" && e.kind !== "lost").map((e) => e.kind))).toEqual([["start"], ["actionCompleted"], ["actionFailed"]]);
    // A script occupies the fast/reactive slot (ADR-0031 clarification): s1, with its kind kept in the record.
    expect(thoughts.every((r) => r.source === `${rover.id}/s1` && r.tier === "S1" && payload(r).brainKind === "script")).toBe(true);
  });

  it("critical battery during goTo: the reflex preempts it and the agent returns to base", async () => {
    const { run } = await runReference();
    const low = agent(run, "low");
    const recs = run.trace.all().filter((r) => r.agentId === low.id);
    const ends = recs.filter((r) => r.kind === "action" && payload(r).op === "end").map((r) => [payload(r).name, payload(r).status]);
    expect(ends).toEqual([
      ["goTo", "preempted"],
      ["returnToBase", "succeeded"],
    ]);
    expect(recs.some((r) => r.kind === "reflex" && r.source === `${low.id}/reflexes`)).toBe(true);
    expect(Math.hypot(low.state.x - 5, low.state.y - 5)).toBeLessThan(1);
  });

  it("changing one agent's algorithm changes the state hash, and the trace explains why (ADR-0028)", async () => {
    const slow = { planning: { byAgent: { rover: { onboardComputeExpansionsPerTick: 300 } } } };
    const astar = await runReference({ runConfig: slow });
    const dijkstra = await runReference({ runConfig: { planning: { byAgent: { rover: { onboardComputeExpansionsPerTick: 300, algorithm: "dijkstra" } } } } });
    // Both find an optimal path, so the agents may end in the same state; the hashes diverge while the
    // rover is still on its way, because its plan completes later.
    expect(dijkstra.checkpoints).not.toEqual(astar.checkpoints);
    expect(dijkstra.checkpoints[0]).not.toBe(astar.checkpoints[0]);
    const firstPlan = (r: typeof astar) => payload(r.run.trace.all().find((x) => x.kind === "compute" && x.agentId === agent(r.run, "rover").id) as TraceRecord);
    expect(firstPlan(astar).algorithm).toBe("astar");
    expect(firstPlan(dijkstra).algorithm).toBe("dijkstra");
    // Dijkstra expands more nodes, so at the same onboard budget its plan completes later in sim time.
    expect(firstPlan(dijkstra).expansionsCharged).toBeGreaterThan(firstPlan(astar).expansionsCharged as number);
    expect(firstPlan(dijkstra).completedTick).toBeGreaterThan(firstPlan(astar).completedTick as number);
    // Other agents are untouched by what the rover plans: their own actions, plans and reflexes are identical. They
    // could only interact through perception (low's camera sees the rover, whose pose differs), which is traced
    // as events and requests, not as the agent's behaviour.
    const behaviour = new Set(["action", "compute", "reflex"]);
    const lowEnd = (r: typeof astar) => r.run.trace.all().filter((x) => x.agentId === agent(r.run, "low").id && behaviour.has(x.kind)).map((x) => x.payload);
    expect(lowEnd(dijkstra)).toEqual(lowEnd(astar));
  });
});

describe("injected researcher commands (ADR-0015 clarification of 2026-10-04): long runs", () => {
  const idle = { rover: [], low: [], scout: [] };

  it("a world-scope goTo is a run input applied in the input phase, traced as injected from world/sim, and runs to success", async () => {
    const run = buildReferenceRun({ scripts: idle });
    await runLockstep(run.world, run.scheduler, 5);
    const input = run.world.inject({ agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } });
    expect(input).toMatchObject({ inputId: "inp-000001", tick: 6, agentId: "ugv-001" });
    await runLockstep(run.world, run.scheduler, 1500);
    const injected = run.trace.all().filter((r) => r.kind === "injected");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ source: "world/sim", agentId: "ugv-001" });
    expect(injected[0]?.simTime).toBeCloseTo(6 * REFERENCE_DT_S, 12); // applied at tick 6
    expect(payload(injected[0] as TraceRecord)).toMatchObject({ op: "command", caller: "world", inputId: "inp-000001", ok: true });
    const start = run.trace.all().find((r) => r.kind === "action" && payload(r).op === "start");
    expect(payload(start as TraceRecord)).toMatchObject({ name: "goTo", caller: "world", inputId: "inp-000001" });
    expect(run.runtime.info("ugv-001")?.status).toBe("succeeded");
  });

  it("replaying the recorded inputs reproduces the run: same state hash at every checkpoint", async () => {
    const live = buildReferenceRun({ scripts: idle });
    const liveHashes: string[] = [];
    for (let k = 0; k < 20; k++) {
      if (k === 2) live.world.inject({ agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } });
      if (k === 7) live.world.inject({ agentId: "uav-001", name: "takeoff", params: { altitudeM: 15 } });
      if (k === 9) live.world.inject({ agentId: "ugv-001", name: "goTo", params: { xM: 20, yM: 40 } });
      await runLockstep(live.world, live.scheduler, 100);
      liveHashes.push(live.world.stateHash);
    }
    const replay = buildReferenceRun({ scripts: idle });
    for (const i of live.world.inputs) replay.world.inject({ agentId: i.agentId, name: i.name, params: i.params }, i.tick);
    const replayHashes: string[] = [];
    for (let k = 0; k < 20; k++) {
      await runLockstep(replay.world, replay.scheduler, 100);
      replayHashes.push(replay.world.stateHash);
    }
    expect(replayHashes).toEqual(liveHashes);
    expect(new Set(liveHashes).size).toBeGreaterThan(5);
  });
});
