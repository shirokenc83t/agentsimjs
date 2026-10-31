import type { Brain, SimAgent } from "@agentsim/core";
import { RunHeader, type TraceRecord } from "@agentsim/trace";
import { isValid, runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun, REFERENCE_DT_S, runReference } from "../testing/reference-run.ts";
import { checkSensorNoise, checkSensorRates, planningTargets } from "./assemble.ts";
import { formatSimulatorVersion, runHeader } from "./run.ts";

function agent(run: ReturnType<typeof buildReferenceRun>, key: string): SimAgent {
  const a = run.agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
}

const payload = (r: TraceRecord) => r.payload as Record<string, unknown>;

// The full reference runs are in run.determinism.test.ts (the `determinism` test project).
describe("world loop (F1 d7)", () => {
  it("range noise above a quarter cell is rejected: hits are localized at cell resolution (ADR-0012 clarification of 2026-10-10)", () => {
    const run = buildReferenceRun();
    expect(checkSensorNoise(run.resolved, run.spatial.grid.resolutionM)).toEqual({ ok: true, value: undefined }); // built-ins: σ 0.02 m
    const noisy = {
      ...run.resolved,
      agents: run.resolved.agents.map((a) => ({ ...a, body: { ...a.body, sensors: a.body.sensors.map((s) => (s.type === "camera" ? s : { ...s, rangeSigmaM: 0.2 })) } })),
    } as typeof run.resolved;
    const r = checkSensorNoise(noisy, 0.5);
    expect(r.ok ? null : r.error.code).toBe("sensor_noise_above_cell");
    expect(checkSensorNoise(noisy, 1).ok).toBe(true); // 0.2 ≤ 1/4
    // Headless runs that skip the check cannot assemble such a sensor (programmer error).
    expect(() => buildReferenceRun({ scripts: {}, bodies: { rover: { sensors: [{ id: "lidar", type: "lidar", rangeSigmaM: 0.2 }] } } })).toThrow(/quarter cell/);
  });

  it("a sensor faster than the run's tick rate is rejected with its code, never capped (ADR-0012 addition)", () => {
    const run = buildReferenceRun();
    expect(checkSensorRates(run.resolved, REFERENCE_DT_S)).toEqual({ ok: true, value: undefined }); // built-ins: 10 Hz at 10 Hz ticks
    const r = checkSensorRates(run.resolved, 0.2); // 5 Hz ticks
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("sensor_rate_above_tick_rate");
      expect(r.error.message).toMatch(/lidar.*10 Hz.*5 Hz/);
    }
  });

  it("planningTargets: one target per agent, from its effective configuration and body", () => {
    const run = buildReferenceRun({ runConfig: { planning: { byKind: { uav: { algorithm: "hpa" } } } } });
    const targets = new Map(planningTargets(run.resolved).map((t) => [t.agentId, t]));
    expect(targets.size).toBe(3);
    const of = (key: string) => targets.get(agent(run, key).id);
    expect([of("rover"), of("low"), of("scout")].map((t) => [t?.traversal.vehicle, t?.config.algorithm.kind])).toEqual([
      ["ugv", "astar"],
      ["ugv", "astar"],
      ["uav", "hpa"],
    ]);
    expect(of("scout")?.traversal.cruiseAltitudeM).toBe((agent(run, "scout").body as { cruiseAltitudeM: number }).cruiseAltitudeM);
  });

  it("an agent without a brain stays idle; a rejected decision is reported back to the brain", async () => {
    const { run } = await runReference({ scripts: { rover: [{ name: "takeoff", params: { altitudeM: 10 } }, { name: "hold", params: {} }] } }, 50);
    const rover = agent(run, "rover");
    const thoughts = run.trace.all().filter((r) => r.agentId === rover.id && r.kind === "thought" && payload(r).op === "decision");
    expect((payload(thoughts[1] as TraceRecord).events as { kind: string; code: string }[])).toMatchObject([{ kind: "actionRejected", name: "takeoff", code: "vehicle_unsupported" }]);
    const scout = agent(run, "scout");
    expect(run.runtime.info(scout.id)).toBeUndefined();
  });

  it("a failing brain does not lose the other brains' answers; only it is asked again", async () => {
    let calls = 0;
    let fail = true;
    const flaky: Brain = {
      id: "flaky",
      tier: "S2",
      decide: () => {
        calls++;
        return fail ? Promise.reject(new Error("timeout")) : Promise.resolve({ decision: { kind: "idle" } });
      },
    };
    const run = buildReferenceRun({ brains: { scout: flaky } });
    await expect(run.world.decide()).rejects.toThrow(/uav-001/);
    expect(run.world.outstanding.map((r) => r.agentId)).toEqual(["uav-001"]);
    fail = false;
    await run.world.decide();
    expect(calls).toBe(2);
    run.scheduler.step();
    // The rover's script was asked exactly once: its first goTo started.
    expect(run.runtime.info("ugv-001")?.name).toBe("goTo");
    const thought = run.trace.all().find((r) => r.kind === "thought" && r.agentId === "uav-001");
    expect(thought?.source).toBe("uav-001/s2");
  });

  it("a world that failed in the middle of a step refuses every later step", async () => {
    const run = buildReferenceRun();
    await run.world.decide();
    const tick = run.runtime.tick.bind(run.runtime);
    run.runtime.tick = () => {
      throw new Error("boom");
    };
    expect(() => run.scheduler.step()).toThrow(/boom/);
    run.runtime.tick = tick;
    expect(() => run.scheduler.step()).toThrow(/failed in an earlier step/);
  });

  it("decisions are awaited before the next tick (lockstep)", async () => {
    const run = buildReferenceRun();
    expect(run.world.outstanding.map((r) => r.agentId)).toEqual(["uav-001", "ugv-001", "ugv-002"]);
    expect(() => run.scheduler.step()).toThrow(/outstanding/);
    await run.world.decide();
    run.scheduler.step();
    expect(run.world.tick).toBe(1);
    expect(run.world.simTimeS).toBeCloseTo(REFERENCE_DT_S, 12);
  });
});

describe("run header (ADR-0028)", () => {
  it("records scenario version, the run configuration, both hashes and the simulator version", () => {
    const run = buildReferenceRun({ runConfig: { seed: 9 } });
    expect(run.agents.length).toBe(3);
    const resolvedHeader = runHeader({
      runId: "run-000001",
      label: "reference",
      createdAtWallMs: 0,
      resolved: {
        document: { schemaVersion: 0, scenario: { id: "f1-reference", version: 1 }, seed: 9 },
        scenario: { id: "f1-reference", version: 1 },
        seed: 9,
        timeMode: "lockstep",
        mindsRunMode: "live",
        minDecisionIntervalS: 1,
        agents: [],
        warnings: [],
        runConfigHash: "0123abcd",
        effectiveConfigHash: "89abcdef",
      },
      simulatorVersion: formatSimulatorVersion("0.0.0", "abc1234", true),
    });
    expect(isValid(RunHeader, resolvedHeader)).toBe(true);
    expect(resolvedHeader).toMatchObject({ scenarioId: "f1-reference", scenarioVersion: 1, seed: 9, runConfigHash: "0123abcd", effectiveConfigHash: "89abcdef", simulatorVersion: "0.0.0+abc1234-dirty" });
    expect(formatSimulatorVersion("1.2.3", "abc1234", false)).toBe("1.2.3+abc1234");
  });

  it("lists the agents with ideal beliefs as resolved, sorted (ADR-0028 addition of 2026-10-10)", () => {
    const run = buildReferenceRun({ runConfig: { beliefs: { default: { init: "unknown" }, byAgent: { scout: { init: "ideal" }, rover: { init: "ideal" } } } } });
    const h = runHeader({ runId: "run-000001", label: "r", createdAtWallMs: 0, resolved: run.resolved, simulatorVersion: "0.0.0+abc1234" });
    const id = (key: string) => run.agents.find((a) => a.key === key)?.id ?? "";
    expect(h.idealAgents).toEqual([id("rover"), id("scout")].sort());
    expect(isValid(RunHeader, h)).toBe(true);
    // The F1 reference run sets every agent ideal.
    expect(runHeader({ runId: "run-000002", label: "r", createdAtWallMs: 0, resolved: buildReferenceRun().resolved, simulatorVersion: "x" }).idealAgents).toHaveLength(3);
  });
});

describe("injected researcher commands (ADR-0015 clarification of 2026-10-04)", () => {
  const idle = { rover: [], low: [], scout: [] };

  it("any other non-self caller of a base action still gets scope_denied; only the input phase injects", () => {
    const run = buildReferenceRun({ scripts: idle });
    const rover = agent(run, "rover");
    for (const caller of [{ scope: "world" as const, id: "world" }, { scope: "leader" as const, id: "grp-001" }, { scope: "self" as const, id: "ugv-002" }]) {
      expect(run.runtime.start(rover, "goTo", { xM: 50, yM: 10 }, caller, 0, 0)).toMatchObject({ ok: false, error: { code: "scope_denied" } });
    }
  });

  it("an injected command preempts the running action like any new action; invalid params are rejected and traced", async () => {
    const run = buildReferenceRun({ scripts: { rover: [{ name: "goTo", params: { xM: 50, yM: 10 } }], low: [], scout: [] } });
    await runLockstep(run.world, run.scheduler, 30);
    expect(run.runtime.isRunning("ugv-001")).toBe(true);
    run.world.inject({ agentId: "ugv-001", name: "goTo", params: { xM: 15, yM: 30 } });
    run.world.inject({ agentId: "ugv-002", name: "goTo", params: { xM: "far" } });
    await runLockstep(run.world, run.scheduler, 1);
    const ends = run.trace.all().filter((r) => r.agentId === "ugv-001" && r.kind === "action" && payload(r).op === "end");
    expect(payload(ends.at(-1) as TraceRecord)).toMatchObject({ status: "preempted" });
    const bad = run.trace.all().filter((r) => r.kind === "injected" && r.agentId === "ugv-002");
    expect(payload(bad[0] as TraceRecord)).toMatchObject({ ok: false, failure: "invalid_params" });
  });

  it("inputs never rewrite history: past ticks and unknown agents are refused", async () => {
    const run = buildReferenceRun({ scripts: idle });
    await runLockstep(run.world, run.scheduler, 10);
    expect(() => run.world.inject({ agentId: "ugv-001", name: "hold", params: {} }, 10)).toThrow(RangeError);
    expect(() => run.world.inject({ agentId: "ugv-999", name: "hold", params: {} })).toThrow(RangeError);
  });
});

describe("cost profiles change paths (ROADMAP F1 acceptance)", () => {
  /** Waypoints of the rover's first plan to (26, 8), with an optional planning default. */
  async function plannedPath(costProfile?: { weights: Record<string, number> }): Promise<[number, number][]> {
    const run = buildReferenceRun({
      scripts: { rover: [{ name: "goTo", params: { xM: 26, yM: 8 } }], low: [], scout: [] },
      ...(costProfile ? { runConfig: { planning: { default: { costProfile } } } } : {}),
    });
    await runLockstep(run.world, run.scheduler, 20);
    const plan = run.trace.all().find((r) => r.kind === "compute" && r.agentId === "ugv-001");
    return payload(plan as TraceRecord).waypoints as [number, number][];
  }

  /** Does the polyline enter the marsh (x ∈ [14, 22), y < 16), sampled every 0.25 m? */
  function crossesMarsh(path: [number, number][]): boolean {
    for (let k = 1; k < path.length; k++) {
      const [x0, y0] = path[k - 1] as [number, number];
      const [x1, y1] = path[k] as [number, number];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25));
      for (let s = 0; s <= n; s++) {
        const x = x0 + ((x1 - x0) * s) / n;
        const y = y0 + ((y1 - y0) * s) / n;
        if (x >= 14 && x < 22 && y < 16) return true;
      }
    }
    return false;
  }

  it("a distance-only profile crosses the marsh; weighing terrain goes around it", async () => {
    expect(crossesMarsh(await plannedPath())).toBe(true);
    expect(crossesMarsh(await plannedPath({ weights: { distance: 1, terrain: 1 } }))).toBe(false);
  });
});
