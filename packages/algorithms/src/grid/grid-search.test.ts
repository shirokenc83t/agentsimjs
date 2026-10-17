import { Rng } from "@agentsim/core";
import { GridSpace, OCCUPANCY_BLOCKED, rectPolygon } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile } from "../cost-profile.ts";
import { isValidPath, pathCost, randomGrid, referenceCost, space, UAV, UGV } from "../testing/fixtures.ts";
import { GridSearch, type GridAlgorithm } from "./grid-search.ts";

const run = (s: ReturnType<typeof space>, a: number, b: number, alg: GridAlgorithm, budget = 1e9) => {
  const q = new GridSearch(s, a, b, alg, budget);
  q.runToCompletion();
  return q;
};

describe("GridSearch (Dijkstra, A*, weighted A*)", () => {
  it("finds optimal paths (vs an independent reference) on random grids and profiles", () => {
    const rng = Rng.fromSeed(77).derive("search-opt");
    for (let trial = 0; trial < 12; trial++) {
      const g = randomGrid(trial, 40);
      const s = space(g, UGV, { weights: { distance: 1, terrain: trial % 3 } });
      for (let q = 0; q < 4; q++) {
        const a = rng.intRange(0, 1599);
        const b = rng.intRange(0, 1599);
        const ref = referenceCost(s, a, b);
        const d = run(s, a, b, { kind: "dijkstra" });
        const astar = run(s, a, b, { kind: "astar" });
        const w = run(s, a, b, { kind: "weighted-astar", weight: 1.5 });
        if (ref === Infinity) {
          for (const r of [d, astar, w]) expect(r.status).toBe("not_found");
          continue;
        }
        expect(d.status).toBe("found");
        expect(d.cost).toBeCloseTo(ref, 9);
        expect(astar.cost).toBeCloseTo(ref, 9);
        expect(astar.expanded).toBeLessThanOrEqual(d.expanded);
        expect(w.cost).toBeLessThanOrEqual(1.5 * ref + 1e-9);
        for (const r of [d, astar, w]) {
          expect(isValidPath(s, r.path())).toBe(true);
          expect(pathCost(s, r.path())).toBeCloseTo(r.cost, 9);
          expect(r.path()[0]).toBe(a);
          expect(r.path().at(-1)).toBe(b);
        }
      }
    }
  });

  it("is resumable: tiny slices give exactly the same path and expansions as one big step", () => {
    const s = space(randomGrid(3, 48));
    const big = run(s, 0, 48 * 48 - 1, { kind: "astar" });
    const sliced = new GridSearch(s, 0, 48 * 48 - 1, { kind: "astar" }, 1e9);
    let steps = 0;
    while (sliced.step(7) === "running") steps++;
    expect(steps).toBeGreaterThan(3);
    expect(sliced.status).toBe(big.status);
    expect(sliced.expanded).toBe(big.expanded);
    expect(sliced.path()).toEqual(big.path());
  });

  it("is deterministic across runs (fixed tie-breaking)", () => {
    const g = new GridSpace({ sizeX: 30, sizeY: 30, resolutionM: 1, chunkSize: 16 }); // empty: many equal paths
    const s = space(g);
    const a = run(s, 0, 29 * 30 + 29, { kind: "astar" }).path();
    const b = run(s, 0, 29 * 30 + 29, { kind: "astar" }).path();
    expect(a).toEqual(b);
  });

  it("reports budget_exceeded and not_found", () => {
    const g = new GridSpace({ sizeX: 30, sizeY: 30, resolutionM: 1, chunkSize: 16 });
    for (let j = 0; j < 30; j++) g.setCell("occupancy", 15, j, OCCUPANCY_BLOCKED); // full wall
    const s = space(g);
    expect(run(s, 0, 29, { kind: "astar" }).status).toBe("not_found");
    const q = run(space(new GridSpace({ sizeX: 30, sizeY: 30, resolutionM: 1, chunkSize: 16 })), 0, 899, { kind: "dijkstra" }, 50);
    expect(q.status).toBe("budget_exceeded");
    expect(q.expanded).toBe(50);
  });

  it("changing the cost profile changes the path (terrain avoidance)", () => {
    const g = new GridSpace({ sizeX: 40, sizeY: 20, resolutionM: 1, chunkSize: 16 });
    for (let j = 0; j < 14; j++) for (let i = 10; i < 30; i++) g.setCell("terrainCost", i, j, 80); // mud ×8 on the direct line
    const start = 5 * 40 + 2;
    const goal = 5 * 40 + 37;
    const direct = run(space(g, UGV, { weights: { distance: 1 } }), start, goal, { kind: "astar" }).path();
    const avoid = run(space(g, UGV, { weights: { distance: 1, terrain: 1 } }), start, goal, { kind: "astar" }).path();
    const maxRow = (p: number[]) => Math.max(...p.map((c) => (c / 40) | 0));
    expect(maxRow(direct)).toBeLessThan(14); // straight through the mud
    expect(maxRow(avoid)).toBeGreaterThanOrEqual(14); // detours around it
  });

  it("applies cell constraints (mask) and edge constraints (turn)", () => {
    const g = new GridSpace({ sizeX: 20, sizeY: 20, resolutionM: 1, chunkSize: 16 });
    for (let j = 0; j < 20; j++) for (let i = 8; i < 12; i++) g.setCell("terrainCost", i, j, 50);
    const blocked = space(g, UGV, { weights: { distance: 1 }, constraints: ["terrain < 4"] });
    expect(run(blocked, 0, 19, { kind: "astar" }).status).toBe("not_found"); // the band is now forbidden
    const turns = space(new GridSpace({ sizeX: 20, sizeY: 20, resolutionM: 1, chunkSize: 16 }), UGV, { weights: { distance: 1 }, constraints: ["turn <= 0.8"] });
    const q = run(turns, 0, 19 * 20 + 19, { kind: "astar" });
    expect(q.status).toBe("found");
    expect(isValidPath(turns, q.path())).toBe(true);
  });

  it("drones go around blocks of unknown height but over recorded heights below their altitude", () => {
    const g = new GridSpace({ sizeX: 60, sizeY: 30, resolutionM: 1, chunkSize: 16, altitudeLimitsM: { min: 0, max: 100 } });
    // Wall A: unknown height (unlimited) across rows 0..24 at x = 20; gap at the top rows 25..29.
    for (let j = 0; j < 25; j++) g.setCell("occupancy", 20, j, OCCUPANCY_BLOCKED);
    // Wall B: recorded 12 m, full height of the map at x = 40 (UAV cruises at 30 m, clearance 2 m).
    for (let j = 0; j < 30; j++) {
      g.setCell("occupancy", 40, j, OCCUPANCY_BLOCKED);
      g.setCell("heightDm", 40, j, 120);
    }
    const s = space(g, UAV);
    const q = run(s, 2 * 60 + 2, 2 * 60 + 57, { kind: "astar" });
    expect(q.status).toBe("found");
    const cells = q.path();
    const crossesAtX = (x: number) => cells.filter((c) => c % 60 === x).map((c) => (c / 60) | 0);
    expect(Math.min(...crossesAtX(20))).toBeGreaterThanOrEqual(25); // around wall A, through the gap
    expect(crossesAtX(40).length).toBeGreaterThan(0); // straight over wall B
    expect(Math.max(...crossesAtX(40))).toBeLessThan(25);
    // A ground vehicle cannot cross wall B at all.
    expect(run(space(g, UGV), 2 * 60 + 2, 2 * 60 + 57, { kind: "astar" }).status).toBe("not_found");
  });

  it("respects no-fly volumes for drones", () => {
    const g = new GridSpace({
      sizeX: 30,
      sizeY: 30,
      resolutionM: 1,
      chunkSize: 16,
      zones: [{ id: "nf", kind: "noFly", polygon: rectPolygon(10, 0, 20, 25), minAltM: 0, maxAltM: 50 }],
    });
    const q = run(space(g, UAV), 5 * 30 + 2, 5 * 30 + 27, { kind: "astar" });
    expect(q.status).toBe("found");
    expect(q.path().every((c) => !(c % 30 >= 10 && c % 30 < 20 && ((c / 30) | 0) < 25))).toBe(true);
  });
});

describe("cost profiles", () => {
  it.each([
    [{ weights: { altitudeChange: 1 } }, "profile_feature_unsupported"],
    [{ weights: { radioCoverage: 2, distance: 1 } }, "profile_feature_unsupported"],
    // F2: `unknown` multiplies the cost into never-observed cells; it must be positive.
    [{ weights: { unknown: 0, distance: 1 } }, "profile_degenerate"],
    [{ weights: { distance: 0 } }, "profile_degenerate"],
    [{ weights: { distance: -1 } }, "invalid_profile"],
    [{ weights: { distance: 1 }, native: "fastest" }, "native_unknown"],
    [{ weights: { distance: 1 }, constraints: ["speed < 3"] }, "constraint_invalid"],
    [{ weights: { distance: 1 }, extra: true }, "invalid_profile"],
    [{ weights: { distance: 1 }, constraints: ["altitude > 1; drop"] }, "constraint_invalid"],
  ])("rejects %j with %s", (input, code) => {
    const r = compileCostProfile(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it("classifies constraints and hashes canonically", () => {
    const r = compileCostProfile({ weights: { terrain: 1, distance: 1 }, constraints: ["terrain < 5", "turn < 1"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cellConstraints.map((c) => c.source)).toEqual(["terrain < 5"]);
    expect(r.value.edgeConstraints.map((c) => c.source)).toEqual(["turn < 1"]);
    expect(r.value.turnAware).toBe(true);
    const same = compileCostProfile({ weights: { distance: 1, terrain: 1 }, constraints: ["terrain < 5", "turn < 1"] });
    expect(same.ok && same.value.hash).toBe(r.value.hash);
  });
});
