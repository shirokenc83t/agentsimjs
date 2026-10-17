import { Rng } from "@agentsim/core";
import { GridSpace, OCCUPANCY_BLOCKED } from "@agentsim/spatial";
import { compileCostProfile, type CostProfile } from "../cost-profile.ts";
import { SearchSpace, type VehicleTraversal } from "../grid/search-space.ts";

export const UGV: VehicleTraversal = { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: 2, energyWhPerM: 0.5 };
export const UAV: VehicleTraversal = { vehicle: "uav", cruiseAltitudeM: 30, clearanceM: 2, speedMps: 8, energyWhPerM: 0.2 };

export function space(grid: GridSpace, t: VehicleTraversal = UGV, profile: CostProfile = { weights: { distance: 1 } }): SearchSpace {
  const p = compileCostProfile(profile);
  if (!p.ok) throw new Error(p.error.message);
  return new SearchSpace(grid, t, p.value);
}

/** Random grid with obstacles and terrain costs (deterministic from the seed). */
export function randomGrid(seed: number, size = 48, obstacleRate = 0.22, chunkSize = 16): GridSpace {
  const rng = Rng.fromSeed(seed).derive("fixtures/random-grid");
  const g = new GridSpace({ sizeX: size, sizeY: size, resolutionM: 1, chunkSize });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (rng.nextFloat01() < obstacleRate) g.setCell("occupancy", i, j, OCCUPANCY_BLOCKED);
      else if (rng.nextFloat01() < 0.3) g.setCell("terrainCost", i, j, rng.intRange(5, 60));
    }
  }
  return g;
}

/**
 * Independent reference: plain O(n²) Dijkstra over the same moves and costs (no heap, no shared code with
 * GridSearch except SearchSpace's move rules), for optimality checks.
 */
export function referenceCost(s: SearchSpace, start: number, goal: number): number {
  const n = s.sizeX * s.sizeY;
  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const done = new Uint8Array(n);
  if (s.mask[start] === 0) return Number.POSITIVE_INFINITY;
  dist[start] = 0;
  for (;;) {
    let u = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      if (done[k] === 0 && (dist[k] ?? Infinity) < best) {
        best = dist[k] ?? Infinity;
        u = k;
      }
    }
    if (u < 0) return Number.POSITIVE_INFINITY;
    if (u === goal) return best;
    done[u] = 1;
    const i = u % s.sizeX;
    const j = (u / s.sizeX) | 0;
    for (let dir = 0; dir < 8; dir++) {
      if (!s.canMove(i, j, dir)) continue;
      const di = [1, 1, 0, -1, -1, -1, 0, 1][dir] ?? 0;
      const dj = [0, 1, 1, 1, 0, -1, -1, -1][dir] ?? 0;
      const v = (j + dj) * s.sizeX + (i + di);
      const c = s.moveCost(i, j, dir, 0);
      if (best + c < (dist[v] ?? Infinity)) dist[v] = best + c;
    }
  }
}

/** True if `path` is a sequence of legal moves through passable cells. */
export function isValidPath(s: SearchSpace, path: readonly number[]): boolean {
  for (let k = 0; k < path.length; k++) {
    const c = path[k] ?? -1;
    if (s.mask[c] === 0) return false;
    if (k === 0) continue;
    const p = path[k - 1] ?? -1;
    const di = (c % s.sizeX) - (p % s.sizeX);
    const dj = ((c / s.sizeX) | 0) - ((p / s.sizeX) | 0);
    const dir = [1, 1, 0, -1, -1, -1, 0, 1].findIndex((x, d) => x === di && [0, 1, 1, 1, 0, -1, -1, -1][d] === dj);
    if (dir < 0 || !s.canMove(p % s.sizeX, (p / s.sizeX) | 0, dir)) return false;
  }
  return true;
}

/** Sum of move costs along a path (no turn costs). */
export function pathCost(s: SearchSpace, path: readonly number[]): number {
  let c = 0;
  for (let k = 1; k < path.length; k++) {
    const p = path[k - 1] ?? 0;
    const q = path[k] ?? 0;
    const di = (q % s.sizeX) - (p % s.sizeX);
    const dj = ((q / s.sizeX) | 0) - ((p / s.sizeX) | 0);
    const dir = [1, 1, 0, -1, -1, -1, 0, 1].findIndex((x, d) => x === di && [0, 1, 1, 1, 0, -1, -1, -1][d] === dj);
    c += s.moveCost(p % s.sizeX, (p / s.sizeX) | 0, dir, 0);
  }
  return c;
}
