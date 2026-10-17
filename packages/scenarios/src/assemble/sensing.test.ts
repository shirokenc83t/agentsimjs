import { runLockstep } from "@agentsim/core";
import { BELIEF_FREE, BELIEF_OCCUPIED, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";

/** Sensing updates the belief maps of `unknown` agents (the F1 reference run defaults to `ideal`). */
const UNKNOWN = { runConfig: { beliefs: { default: { init: "unknown" as const } } } };

const agentOf = (run: ReturnType<typeof buildReferenceRun>, key: string) => {
  const a = run.agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
};

describe("sensing in the world loop (F2 M2a, ADR-0012 addition of 2026-10-09)", () => {
  it("agents start knowing nothing; after their lidar reads, nearby free ground is believed free and walls occupied", async () => {
    const run = buildReferenceRun({ ...UNKNOWN, scripts: {} });
    const rover = agentOf(run, "rover");
    const b = run.sensing.belief(rover.id);
    const ci = run.spatial.grid.cellI(rover.state.x);
    const cj = run.spatial.grid.cellJ(rover.state.y);
    expect(b.state(ci + 2, cj)).not.toBe(BELIEF_FREE);
    await runLockstep(run.world, run.scheduler, 2); // the 10 Hz lidar reads within the first tick
    expect(b.state(ci + 2, cj)).toBe(BELIEF_FREE);
    // Somewhere within lidar range the demo's walls were hit.
    const g = run.spatial.grid;
    let occupied = 0;
    for (let j = 0; j < g.sizeY; j++) for (let i = 0; i < g.sizeX; i++) if (b.state(i, j) === BELIEF_OCCUPIED) occupied++;
    expect(occupied).toBeGreaterThan(0);
  });

  it("is deterministic: the same run gives the same belief maps (noise from seeded sub-streams)", async () => {
    const hashes = async () => {
      const run = buildReferenceRun(UNKNOWN);
      await runLockstep(run.world, run.scheduler, 50);
      return run.agents.map((a) => run.sensing.beliefHash(a.id));
    };
    const a = await hashes();
    expect(await hashes()).toEqual(a);
    expect(new Set(a).size).toBe(a.length); // agents see different things
  });

  it("proximity hits are what the agent sensed: none in open ground, some next to a wall", async () => {
    const run = buildReferenceRun({ ...UNKNOWN, scripts: {} });
    const rover = agentOf(run, "rover");
    await runLockstep(run.world, run.scheduler, 2);
    expect(run.sensing.hits(rover.id)).toEqual([]);
    // A wall 1 m to the east of the rover, inside its 2 m proximity range.
    const g = run.spatial.grid;
    const wi = g.cellI(rover.state.x + 1.2);
    for (let j = g.cellJ(rover.state.y) - 3; j <= g.cellJ(rover.state.y) + 3; j++) g.setCell("occupancy", wi, j, OCCUPANCY_BLOCKED);
    await runLockstep(run.world, run.scheduler, 2);
    expect(run.sensing.hits(rover.id).length).toBeGreaterThan(0);
  });

  it("a stationary agent facing a wall reaches a stable belief: no believed-state change for 100 readings after convergence (ADR-0012 clarification of 2026-10-10)", async () => {
    const run = buildReferenceRun({ ...UNKNOWN, scripts: {} });
    const rover = agentOf(run, "rover");
    const g = run.spatial.grid;
    const wi = g.cellI(rover.state.x + 4);
    for (let j = g.cellJ(rover.state.y) - 6; j <= g.cellJ(rover.state.y) + 6; j++) g.setCell("occupancy", wi, j, OCCUPANCY_BLOCKED);
    const b = run.sensing.belief(rover.id);
    await runLockstep(run.world, run.scheduler, 30); // converge: 30 readings at 10 Hz
    expect(b.state(wi, g.cellJ(rover.state.y))).toBe(BELIEF_OCCUPIED);
    expect(b.state(wi - 2, g.cellJ(rover.state.y))).toBe(BELIEF_FREE);
    const v = b.planVersion;
    await runLockstep(run.world, run.scheduler, 100);
    expect(b.planVersion).toBe(v);
  });

  it("contact is a bump observation: touched cells believed occupied at the clamp, traced from <agent>/sensors", () => {
    const run = buildReferenceRun({ ...UNKNOWN, scripts: {} });
    const rover = agentOf(run, "rover");
    run.sensing.contact(rover.id, [3, 4, 5, 4], 0, 1.5);
    const b = run.sensing.belief(rover.id);
    expect(b.logOdds(3, 4)).toBe(100);
    expect(b.logOdds(5, 4)).toBe(100);
    const rec = run.trace.all().find((r) => r.kind === "observation");
    expect(rec).toMatchObject({ source: `${rover.id}/sensors`, payload: { op: "contact", cells: [3, 4, 5, 4], lowerM: 0 } });
  });

  it("a camera detects a scenario object in range and in view, never one beyond its range and behind a wall", async () => {
    const run = buildReferenceRun({
      ...UNKNOWN,
      scripts: {},
      objects: [
        { id: "near", kind: "target", position: { xM: 14, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } },
        // 45 m away (camera range 40 m) and behind the demo's wall at x = 30.
        { id: "far", kind: "target", position: { xM: 55, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } },
      ],
    });
    const rover = agentOf(run, "rover"); // at (10, 10) facing east, camera 90°, 40 m
    await runLockstep(run.world, run.scheduler, 3); // the 5 Hz camera reads within two ticks
    const seen = run.sensing.entities(rover.id);
    expect(seen.has("near")).toBe(true);
    expect(seen.has("far")).toBe(false);
    expect(seen.get("near")?.observedAtS).toBeGreaterThan(0);
  });

  it("a reading lost to a dropout is traced at the start and the end of the streak", async () => {
    const run = buildReferenceRun({
      ...UNKNOWN,
      scripts: {},
      bodies: { rover: { sensors: [{ id: "lidar", type: "lidar", dropoutProbability: 1 }] } },
    });
    const rover = agentOf(run, "rover");
    await runLockstep(run.world, run.scheduler, 5);
    const drops = run.trace.all().filter((r) => r.source === `${rover.id}/sensors` && (r.payload as { op: string }).op === "dropout");
    expect(drops).toHaveLength(1); // one streak start; it never ends
    expect(drops[0]?.payload).toMatchObject({ op: "dropout", sensor: "lidar", state: "start" });
    expect(run.sensing.belief(rover.id).materializedChunks).toBe(0); // nothing observed
  });
});
