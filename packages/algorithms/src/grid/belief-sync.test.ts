import { Rng } from "@agentsim/core";
import { BeliefGrid, BeliefMap, GridSpace, missionOf } from "@agentsim/spatial";
import { describe, expect, it } from "vitest";
import { compileCostProfile } from "../cost-profile.ts";
import { SearchSpace, type VehicleTraversal } from "./search-space.ts";

const profile = (() => {
  const p = compileCostProfile({ weights: { distance: 1, unknown: 3 } });
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
})();

const UGV = (inflationRadiusM: number): VehicleTraversal => ({ vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.05, inflationRadiusM });
const UAV: VehicleTraversal = { vehicle: "uav", cruiseAltitudeM: 10, clearanceM: 2, speedMps: 8, energyWhPerM: 0.02 };

/**
 * Live views over belief grids refresh only the changed cells and their inflation (F2 M2c2 budget pass): after any
 * sequence of belief updates, a synced view equals a view built from scratch (mask and unknown flags).
 */
describe("per-cell sync of live views over belief grids", () => {
  it.each([
    ["UGV, no inflation", UGV(0)],
    ["UGV, inflation 1.1 m", UGV(1.1)],
    ["UAV at 10 m (height bounds)", UAV],
  ])("%s: synced view = fresh view after every random update batch", (_name, t) => {
    for (let s = 0; s < 10; s++) {
      const r = Rng.fromSeed(77).derive(`belief-sync/${s}`);
      const world = new GridSpace({ sizeX: 64, sizeY: 48, resolutionM: 0.5, chunkSize: 16, altitudeLimitsM: { min: 0, max: 60 } });
      const b = new BeliefMap(64, 48, 16);
      const g = new BeliefGrid(missionOf(world), b);
      const live = new SearchSpace(g, t, profile);
      for (let round = 0; round < 25; round++) {
        const n = 1 + (r.nextU32() % 40);
        for (let k = 0; k < n; k++) {
          const i = r.nextU32() % 64;
          const j = r.nextU32() % 48;
          const op = r.nextU32() % 4;
          if (op === 0) b.observeFree(i, j, 20 + (r.nextU32() % 21));
          else if (op === 1) b.observeHit(i, j, (r.nextU32() % 300) / 10, 20 + (r.nextU32() % 21));
          else if (op === 2) b.observeUnder(i, j, (r.nextU32() % 300) / 10, 20 + (r.nextU32() % 21));
          else b.observeContact(i, j, (r.nextU32() % 100) / 10);
        }
        live.sync();
        const fresh = new SearchSpace(g, t, profile);
        expect(live.mask, `seed ${s} round ${round}`).toEqual(fresh.mask);
        expect(live.unknown).toEqual(fresh.unknown);
      }
    }
    // Each case takes ~1.7 s alone and builds 250 fresh views; under a loaded full run (dozens of workers) the default
    // 5 s was exceeded once. The cases are fully seeded (fixed `Rng` seed, the seed and round are in the assertion
    // message), so a failure replays exactly; only the time budget needed room.
  }, 30_000);

  it("a view behind the retained change log falls back to the chunk path and is still exact", () => {
    const world = new GridSpace({ sizeX: 256, sizeY: 256, resolutionM: 0.5, chunkSize: 32 });
    const b = new BeliefMap(256, 256, 32);
    const g = new BeliefGrid(missionOf(world), b);
    const live = new SearchSpace(g, UGV(0.6), profile);
    // More changes than the log keeps (32k entries) before the next sync.
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) b.observeFree(i, j, 40);
    for (let j = 0; j < 256; j += 3) b.observeHit(100, j, 0, 40);
    expect(b.cellsPlanChangedSince(0)).toBeUndefined();
    live.sync();
    expect(live.mask).toEqual(new SearchSpace(g, UGV(0.6), profile).mask);
  });
});
