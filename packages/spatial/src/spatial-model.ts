import type { GridSpace } from "./grid/grid-space.ts";
import { newRayHit, raycast2d, type RayHit } from "./raycast.ts";
import { SpatialHash } from "./spatial-hash.ts";

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** How a body interacts with the ground-truth layers (UAVs: 2.5D airspace; UGVs: ground). */
export type VehicleClass = "ground" | "air";

/**
 * Common interface of spatial models (ADR-0012; ROADMAP appendix). Grid now, road graphs in F14.
 * Path planning lives in `packages/algorithms` and takes a SpatialModel (ADR-0014, ADR-0024);
 * the topological layer (`regions()`) arrives in F2.
 */
export interface SpatialModel {
  readonly kind: "grid" | "graph";
  /** Increments on every ground-truth edit (caches key on it). */
  readonly version: number;
  isFree(p: Vec3, vehicle: VehicleClass, clearanceM?: number): boolean;
  /** 2D raycast in the horizontal plane (z ignored in F1); allocation-free via `out`. */
  raycast(origin: Vec3, dir: Vec3, maxRangeM: number, out?: RayHit): RayHit;
  /** Entity ids within `radiusM` (horizontal), sorted by id. */
  neighbors(p: Vec3, radiusM: number, excludeId?: string): string[];
  setEntityPosition(id: string, p: Vec3): void;
  removeEntity(id: string): void;
}

/** SpatialModel over a ground-truth GridSpace, with a chunk-aligned spatial hash for neighbors. */
export class GridSpatialModel implements SpatialModel {
  readonly kind = "grid" as const;
  private readonly hash: SpatialHash;
  private readonly blocked: (i: number, j: number) => boolean;

  constructor(readonly grid: GridSpace) {
    this.hash = new SpatialHash(grid.chunkSize * grid.resolutionM, grid.chunksX);
    this.blocked = (i, j) => grid.isBlocked(i, j);
  }

  get version(): number {
    return this.grid.version;
  }

  isFree(p: Vec3, vehicle: VehicleClass, clearanceM = 0): boolean {
    return vehicle === "air" ? this.grid.isFreeForAir(p.x, p.y, p.z, clearanceM) : this.grid.isFreeForGround(p.x, p.y);
  }

  raycast(origin: Vec3, dir: Vec3, maxRangeM: number, out: RayHit = newRayHit()): RayHit {
    return raycast2d(this.blocked, this.grid.resolutionM, origin.x, origin.y, dir.x, dir.y, maxRangeM, out);
  }

  neighbors(p: Vec3, radiusM: number, excludeId?: string): string[] {
    return this.hash.queryRadius(p.x, p.y, radiusM, excludeId);
  }

  setEntityPosition(id: string, p: Vec3): void {
    this.hash.set(id, p.x, p.y);
  }

  removeEntity(id: string): void {
    this.hash.remove(id);
  }
}
