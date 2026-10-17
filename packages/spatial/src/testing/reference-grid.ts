import { GridSpace, OCCUPANCY_BLOCKED } from "../grid/grid-space.ts";
import { rectPolygon } from "../zones.ts";

/** Builds the contract reference world (see testing/contract.ts) as a 128 × 128 grid at 0.5 m. */
export function buildReferenceGrid(): GridSpace {
  const g = new GridSpace({
    sizeX: 128,
    sizeY: 128,
    resolutionM: 0.5,
    chunkSize: 64,
    altitudeLimitsM: { min: 0, max: 60 },
    zones: [{ id: "nofly-a", kind: "noFly", polygon: rectPolygon(40, 40, 50, 50), minAltM: 0, maxAltM: 30 }],
  });
  for (let j = 0; j < 80; j++) for (let i = 60; i < 62; i++) g.setCell("occupancy", i, j, OCCUPANCY_BLOCKED); // wall x∈[30,31), y∈[0,40)
  for (let j = 100; j < 108; j++) {
    for (let i = 20; i < 28; i++) {
      g.setCell("occupancy", i, j, OCCUPANCY_BLOCKED); // building x∈[10,14), y∈[50,54)
      g.setCell("heightDm", i, j, 100); // 10 m
    }
  }
  return g;
}
