import { Rng } from "@agentsim/core";
import { GridSpace, OCCUPANCY_BLOCKED } from "../grid/grid-space.ts";

/** Seed of the reference world used by the benchmarks and the lab preset. */
export const REFERENCE_WORLD_SEED = 1;

/**
 * Reference world for F1: 1 km² at 0.5 m (2000 × 2000 cells, 32 × 32 chunks). Deterministic content:
 * rectangular buildings with heights, terrain-cost bands. The benchmarks (spatial, algorithms, scenarios) and
 * the lab's "1 km² reference world" preset build it here, so they measure and show the same world.
 */
export function buildReferenceWorld(seed = REFERENCE_WORLD_SEED): GridSpace {
  const rng = Rng.fromSeed(seed).derive("bench/reference-world");
  const g = new GridSpace({ sizeX: 2000, sizeY: 2000, resolutionM: 0.5, chunkSize: 64, altitudeLimitsM: { min: 0, max: 120 } });
  for (let b = 0; b < 400; b++) {
    const i0 = rng.intRange(0, 1960);
    const j0 = rng.intRange(0, 1960);
    const w = rng.intRange(4, 40);
    const h = rng.intRange(4, 40);
    const heightDm = rng.intRange(30, 400);
    for (let j = j0; j < j0 + h; j++) {
      for (let i = i0; i < i0 + w; i++) {
        g.setCell("occupancy", i, j, OCCUPANCY_BLOCKED);
        g.setCell("heightDm", i, j, heightDm);
      }
    }
  }
  for (let band = 0; band < 20; band++) {
    const j0 = rng.intRange(0, 1990);
    const cost = rng.intRange(15, 60);
    for (let j = j0; j < j0 + 10; j++) for (let i = 0; i < 2000; i++) g.setCell("terrainCost", i, j, cost);
  }
  return g;
}
