import { runLockstep, ScriptBrain, StateHasher, type ScriptStep } from "@agentsim/core";
import { BELIEF_UNKNOWN } from "@agentsim/spatial";
import { TraceBuffer } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { loadScenario, type LoadedScenario } from "../load.ts";
import { resolveRunConfig } from "../run-config/resolve.ts";
import type { ScenarioDocument } from "../schema.ts";
import { createRun } from "./run.ts";

/** A UGV with `unknown` beliefs; world `w × h` metres at 0.5 m, chunks of 16 cells. */
function scenario(wM: number, hM: number, start: [number, number], body: Record<string, unknown> = {}): ScenarioDocument {
  return {
    schemaVersion: 0,
    id: "explore",
    name: "Explore",
    defaultSeed: 11,
    world: { resolutionM: 0.5, sizeCells: { x: wM * 2, y: hM * 2 }, chunkSize: 16, altitudeLimitsM: { min: 0, max: 60 }, layers: {} },
    zones: [],
    agents: [{ kind: "ugv", key: "rover", start: { xM: start[0], yM: start[1] }, body }],
  };
}

function build(doc: ScenarioDocument, paint: (l: LoadedScenario) => void, steps: ScriptStep[]) {
  const l = loadScenario(doc);
  if (!l.ok) throw new Error(l.error.message);
  paint(l.value);
  const r = resolveRunConfig({ schemaVersion: 0, scenario: { id: "explore", version: 1 } }, { loaded: l.value, version: 1 });
  if (!r.ok) throw new Error(r.error.message);
  const trace = new TraceBuffer("run-000001", () => 0, 2_000_000);
  const run = createRun(l.value, r.value, trace, { dtS: 0.1, brains: { rover: new ScriptBrain("script-rover", steps) } });
  const rover = run.agents[0];
  if (!rover) throw new Error("rover");
  return { run, trace, rover, loaded: l.value };
}

async function untilEnd(run: ReturnType<typeof build>["run"], trace: TraceBuffer, agentId: string, maxTicks: number) {
  for (let t = 0; t < maxTicks; t++) {
    await runLockstep(run.world, run.scheduler, 1);
    const end = trace.all().find((r) => r.agentId === agentId && r.kind === "action" && (r.payload as { op?: string; name?: string }).op === "end" && (r.payload as { name?: string }).name === "explore");
    if (end) return end.payload as { status: string; result?: { reason: string; groupsVisited: number; groupsMarked: number; distanceM: number }; failure?: { code: string } };
  }
  throw new Error("explore did not end");
}

const wall = (l: LoadedScenario, i0: number, j0: number, i1: number, j1: number, heightDm = 0) => {
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      l.grid.setCell("occupancy", i, j, 1);
      if (heightDm > 0) l.grid.setCell("heightDm", i, j, heightDm);
    }
  }
};

describe("explore in a full run (ADR-0039 and its addition of 2026-10-10)", () => {
  it("a UGV explores a walled 40 × 40 m area until frontiers are exhausted; its belief covers what it can reach", async () => {
    const { run, trace, rover, loaded } = build(
      scenario(40, 40, [5, 5]),
      (l) => {
        wall(l, 30, 0, 32, 60); // a wall with a gap at the top
        wall(l, 50, 20, 52, 80); // a second one with a gap at the bottom
      },
      [{ name: "explore", params: {} }],
    );
    const end = await untilEnd(run, trace, rover.id, 30_000);
    expect(end.status).toBe("succeeded");
    expect(end.result?.reason).toBe("frontier_exhausted");
    expect(end.result?.groupsVisited).toBeGreaterThan(0);
    // Coverage of the reachable free area (4-connected flood fill of the truth from the start).
    const g = loaded.grid;
    const b = run.sensing.belief(rover.id);
    const seen = new Uint8Array(g.sizeX * g.sizeY);
    const queue = [g.cellJ(5) * g.sizeX + g.cellI(5)];
    seen[queue[0] ?? 0] = 1;
    let reachable = 0;
    let known = 0;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q] ?? 0;
      const i = c % g.sizeX;
      const j = (c / g.sizeX) | 0;
      reachable++;
      if (b.state(i, j) !== BELIEF_UNKNOWN) known++;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di;
        const d = j + dj;
        if (!g.inBounds(a, d) || g.isBlocked(a, d) || seen[d * g.sizeX + a] === 1) continue;
        seen[d * g.sizeX + a] = 1;
        queue.push(d * g.sizeX + a);
      }
    }
    expect(known / reachable).toBeGreaterThan(0.95);
  });

  it("a frontier seen over a low wall is unreachable: marked despite range noise, and exploration still ends within a bounded number of queries", async () => {
    const { run, trace, rover } = build(
      // The beam's lower edge is 0.4 m: the rover sees over a 0.3 m wall that it cannot drive over.
      scenario(40, 30, [5, 15], { sensors: [{ id: "lidar", type: "lidar", beamHalfHeightM: 0.1 }] }),
      (l) => wall(l, 40, 0, 41, 60, 3),
      [{ name: "explore", params: {} }],
    );
    const end = await untilEnd(run, trace, rover.id, 30_000);
    expect(end.status).toBe("succeeded");
    expect(end.result?.reason).toBe("frontier_exhausted");
    expect(end.result?.groupsMarked).toBeGreaterThan(0);
    const mine = trace.all().filter((r) => r.agentId === rover.id);
    const marks = mine.filter((r) => (r.payload as { op?: string }).op === "frontier-mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((r) => r.source === `${rover.id}/beliefs`)).toBe(true);
    // Noise never clears a mark here: the planning view does not change around the frontiers behind the wall.
    expect(mine.filter((r) => (r.payload as { op?: string }).op === "frontier-unmark")).toHaveLength(0);
    const plans = mine.filter((r) => r.kind === "compute" && (r.payload as { op?: string }).op === "plan");
    expect(plans.length).toBeLessThan(60);
    // Marks are agent state: they are in the state hash.
    const h = new StateHasher();
    run.topology.hashInto(h);
    expect(h.hex()).not.toBe(new StateHasher().hex());
  });

  it("an agent without a range sensor cannot explore (hasRangeSensor); one whose sensors read nothing fails no_map_data after 2 s", async () => {
    // Camera only: no lidar or proximity.
    const cameraOnly = build(scenario(40, 30, [5, 15], { sensors: [{ id: "cam", type: "camera" }] }), () => {}, []);
    const rover = cameraOnly.rover;
    expect(cameraOnly.run.runtime.start(rover, "explore", {}, { scope: "self", id: rover.id }, 0, 0)).toMatchObject({ ok: false, error: { code: "precondition_failed" } });
    // A lidar that drops every reading: the agent never learns anything about its own position.
    const blind = build(scenario(40, 30, [5, 15], { sensors: [{ id: "lidar", type: "lidar", dropoutProbability: 1 }] }), () => {}, [{ name: "explore", params: {} }]);
    const end = await untilEnd(blind.run, blind.trace, blind.rover.id, 100);
    expect(end.status).toBe("failed");
    expect(end.failure?.code).toBe("no_map_data");
  });

  it("a plain goTo aimed at a frontier point sets marks: they are agent state shared with explore", async () => {
    const { run, trace, rover } = build(scenario(40, 30, [5, 15], { sensors: [{ id: "lidar", type: "lidar", beamHalfHeightM: 0.1 }] }), (l) => wall(l, 40, 0, 41, 60, 3), [{ name: "goTo", params: { xM: 30, yM: 15 } }]);
    for (let t = 0; t < 600; t++) await runLockstep(run.world, run.scheduler, 1);
    // Find a frontier behind the low wall, send the rover there with a plain goTo, and see it marked.
    const behind = run.topology.candidates(rover.id).find((c) => c.xM > 20.5);
    if (!behind) throw new Error("no frontier behind the wall");
    expect(run.runtime.start(rover, "goTo", { xM: behind.xM, yM: behind.yM }, { scope: "self", id: rover.id }, 600, 60).ok).toBe(true);
    for (let t = 600; t < 2500 && run.runtime.isRunning(rover.id); t++) await runLockstep(run.world, run.scheduler, 1);
    expect(trace.all().some((r) => (r.payload as { op?: string }).op === "frontier-mark" && r.agentId === rover.id)).toBe(true);
    expect(run.topology.markedCount(rover.id)).toBeGreaterThan(0);
  });

  it("a mark clears when the planning view changes around its group, not on belief updates that keep the view", () => {
    const { run, trace, rover } = build(scenario(40, 30, [5, 15]), () => {}, []);
    const b = run.sensing.belief(rover.id);
    // Believed: free ground x < 20 m, a wall at x = 20 m, free ground beyond it up to x = 25 m (a frontier there).
    for (let j = 0; j < 60; j++) {
      for (let i = 0; i < 50; i++) b.observeFree(i, j, 40);
      b.observeHit(40, j, 0, 40);
      b.observeHit(40, j, 0, 40);
    }
    run.planner.syncViews();
    run.topology.update();
    const group = run.topology.candidates(rover.id).find((c) => c.xM > 20);
    if (!group) throw new Error("no frontier behind the believed wall");
    expect(run.topology.markAt(rover.id, group.xM, group.yM, 1)).toBe(true);
    expect(run.topology.candidates(rover.id).some((c) => c.point === group.point)).toBe(false);
    // Log-odds steps that keep every believed state: the view does not change, the mark stays.
    for (let j = 0; j < 60; j++) b.observeFree(10, j, 20);
    run.planner.syncViews();
    run.topology.update(2);
    expect(run.topology.candidates(rover.id).some((c) => c.point === group.point)).toBe(false);
    // The believed wall next to the group turns out to be free: the view changes there, the mark clears.
    for (let j = 0; j < 60; j++) for (let k = 0; k < 8; k++) b.observeFree(40, j, 40);
    run.planner.syncViews();
    run.topology.update(3);
    expect(trace.all().filter((r) => (r.payload as { op?: string }).op === "frontier-unmark").length).toBeGreaterThan(0);
    expect(run.topology.markedCount(rover.id)).toBe(0);
  });

  it("explore(region) on a region the rover has never seen first approaches it, then explores it", async () => {
    const { run, trace, rover } = build(
      scenario(80, 30, [5, 15], { sensors: [{ id: "lidar", type: "lidar", rangeM: 8 }] }),
      () => {},
      [{ name: "explore", params: { region: "r-02-00" } }],
    );
    const end = await untilEnd(run, trace, rover.id, 40_000);
    expect(end.status).toBe("succeeded");
    expect(end.result?.reason).toBe("region_explored");
    const targets = trace
      .all()
      .filter((r) => r.agentId === rover.id && (r.payload as { op?: string }).op === "explore-target")
      .map((r) => r.payload as { region: string; approach?: string });
    expect(targets[0]?.approach).toBe("r-02-00"); // approached from outside first
    expect(targets.some((t) => t.region === "r-02-00" && t.approach === undefined)).toBe(true); // then explored inside
    const reg = run.topology.of(rover.id).regions().find((r) => r.id === "r-02-00");
    expect((reg?.known ?? 0) / (reg?.cells ?? 1)).toBeGreaterThan(0.9);
  });
});
