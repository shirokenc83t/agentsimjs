import type { StateHasher } from "@agentsim/core";
import { ZoneSet, type Zone } from "../zones.ts";
import { ChunkedLayer } from "./chunked-layer.ts";
import type { PlanningGrid } from "./planning-grid.ts";
import { OccupancyPyramid } from "./pyramid.ts";

/** Layer defaults (ADR-0025): free, nominal terrain cost ×1.0, ground at 0 m. */
export const OCCUPANCY_FREE = 0;
export const OCCUPANCY_BLOCKED = 1;
export const TERRAIN_NOMINAL = 10;
export const TERRAIN_IMPASSABLE = 0;

export type LayerName = "occupancy" | "terrainCost" | "heightDm";

export interface GridSpaceSpec {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize?: number;
  readonly altitudeLimitsM?: { readonly min: number; readonly max: number };
  readonly zones?: readonly Zone[];
  /**
   * Height applied to occupied cells with unknown height (`heightDm` = 0) for aerial vehicles
   * (ADR-0012/0025 additions). Absent = unlimited: such cells block aerial vehicles at every altitude.
   */
  readonly defaultObstacleHeightM?: number;
}

export const MAX_GRID_CELLS_PER_SIDE = 8192;

/**
 * Ground-truth grid (ADR-0012, ADR-0025): occupancy, terrain cost and height in chunks, plus zones and
 * altitude limits for 2.5D. Coordinates: metres, x east, y north, z up; cell (i, j) covers
 * [i·res, (i+1)·res) × [j·res, (j+1)·res). Every edit bumps `version` and stamps the chunk, so any
 * number of consumers (renderer, planner caches, pyramid) can ask what changed since their last look.
 */
export class GridSpace implements PlanningGrid {
  readonly kind = "grid" as const;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly resolutionM: number;
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly altitudeLimitsM: { readonly min: number; readonly max: number };
  /** Undefined = unknown-height obstacles are unlimited. */
  readonly defaultObstacleHeightM: number | undefined;
  readonly zones: ZoneSet;
  readonly occupancy: ChunkedLayer<Uint8Array>;
  readonly terrainCost: ChunkedLayer<Uint8Array>;
  readonly heightDm: ChunkedLayer<Uint16Array>;
  private versionCounter = 0;
  private readonly chunkVersion: Uint32Array;
  private pyramidSeen = 0;
  private pyramidInstance: OccupancyPyramid | undefined;

  constructor(spec: GridSpaceSpec) {
    const cs = spec.chunkSize ?? 64;
    for (const [name, v] of [["sizeX", spec.sizeX], ["sizeY", spec.sizeY]] as const) {
      if (!Number.isInteger(v) || v < 1 || v > MAX_GRID_CELLS_PER_SIDE) throw new RangeError(`${name} must be an integer in [1, ${MAX_GRID_CELLS_PER_SIDE}]: ${v}`);
    }
    if (!(spec.resolutionM > 0) || !Number.isFinite(spec.resolutionM)) throw new RangeError(`resolutionM must be positive: ${spec.resolutionM}`);
    if (!Number.isInteger(cs) || cs < 8 || cs > 256 || (cs & (cs - 1)) !== 0) throw new RangeError(`chunkSize must be a power of two in [8, 256]: ${cs}`);
    this.sizeX = spec.sizeX;
    this.sizeY = spec.sizeY;
    this.resolutionM = spec.resolutionM;
    this.chunkSize = cs;
    this.chunksX = Math.ceil(spec.sizeX / cs);
    this.chunksY = Math.ceil(spec.sizeY / cs);
    this.altitudeLimitsM = spec.altitudeLimitsM ?? { min: 0, max: 120 };
    const d = spec.defaultObstacleHeightM;
    if (d !== undefined && !(Number.isFinite(d) && d > 0 && d <= this.altitudeLimitsM.max)) {
      throw new RangeError(`defaultObstacleHeightM must be finite, > 0 and <= the altitude ceiling: ${d}`);
    }
    this.defaultObstacleHeightM = d;
    this.zones = new ZoneSet(spec.zones ?? []);
    this.occupancy = new ChunkedLayer(this.chunksX, this.chunksY, cs, OCCUPANCY_FREE, Uint8Array);
    this.terrainCost = new ChunkedLayer(this.chunksX, this.chunksY, cs, TERRAIN_NOMINAL, Uint8Array);
    this.heightDm = new ChunkedLayer(this.chunksX, this.chunksY, cs, 0, Uint16Array);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksY);
  }

  get version(): number {
    return this.versionCounter;
  }

  get widthM(): number {
    return this.sizeX * this.resolutionM;
  }

  get heightM(): number {
    return this.sizeY * this.resolutionM;
  }

  private layer(name: LayerName): ChunkedLayer<Uint8Array> | ChunkedLayer<Uint16Array> {
    return name === "occupancy" ? this.occupancy : name === "terrainCost" ? this.terrainCost : this.heightDm;
  }

  // ---- coordinates -------------------------------------------------------------------------------

  cellI(x: number): number {
    return Math.floor(x / this.resolutionM);
  }

  cellJ(y: number): number {
    return Math.floor(y / this.resolutionM);
  }

  /** Centre of cell (i, j) in metres. */
  cellCenterX(i: number): number {
    return (i + 0.5) * this.resolutionM;
  }

  cellCenterY(j: number): number {
    return (j + 0.5) * this.resolutionM;
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.sizeX && j < this.sizeY;
  }

  chunkIndexOfCell(i: number, j: number): number {
    return ((j / this.chunkSize) | 0) * this.chunksX + ((i / this.chunkSize) | 0);
  }

  // ---- edits (world scope: scenario load, scenario editor; F2 discovery acts on belief maps) ----

  /** Sets one cell; returns true if the value changed. */
  setCell(name: LayerName, i: number, j: number, value: number): boolean {
    if (!this.inBounds(i, j)) throw new RangeError(`cell (${i}, ${j}) outside the grid`);
    const changed = this.layer(name).set(i, j, value);
    if (changed) this.touch(this.chunkIndexOfCell(i, j));
    return changed;
  }

  /** Replaces a chunk of one layer (row-major values). */
  setChunk(name: LayerName, ci: number, cj: number, values: ArrayLike<number>): void {
    this.layer(name).setChunk(ci, cj, values);
    this.touch(cj * this.chunksX + ci);
  }

  fillChunk(name: LayerName, ci: number, cj: number, value: number): void {
    this.layer(name).fillChunk(ci, cj, value);
    this.touch(cj * this.chunksX + ci);
  }

  private touch(chunkIndex: number): void {
    this.versionCounter++;
    this.chunkVersion[chunkIndex] = this.versionCounter;
  }

  /** Chunk indices (sorted) changed after `sinceVersion`. */
  chunksChangedSince(sinceVersion: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.chunkVersion.length; k++) if ((this.chunkVersion[k] ?? 0) > sinceVersion) out.push(k);
    return out;
  }

  // ---- queries --------------------------------------------------------------------------------------

  isBlocked(i: number, j: number): boolean {
    return !this.inBounds(i, j) || this.occupancy.get(i, j) !== OCCUPANCY_FREE;
  }

  /** The ground truth has no unknown cells (PlanningGrid: belief grids do). */
  readonly hasUnknown = false;

  isUnknown(_i: number, _j: number): boolean {
    return false;
  }

  /** Every cell is known: free (1) or blocked (2), as in PlanningGrid.classifyChunk. */
  classifyChunk(ci: number, cj: number, out: Uint8Array): boolean {
    const cs = this.chunkSize;
    for (let lj = 0; lj < cs; lj++) {
      const j = cj * cs + lj;
      for (let li = 0; li < cs; li++) {
        const i = ci * cs + li;
        out[lj * cs + li] = i < this.sizeX && j < this.sizeY && this.occupancy.get(i, j) === OCCUPANCY_FREE ? 1 : 2;
      }
    }
    return true;
  }

  /** Terrain cost multiplier (×0.1 units, 10 = ×1.0); 0 = impassable for ground vehicles. */
  terrainAt(i: number, j: number): number {
    return this.terrainCost.get(i, j);
  }

  groundHeightM(i: number, j: number): number {
    return this.heightDm.get(i, j) / 10;
  }

  /** Free for a ground vehicle at (x, y): in bounds, not occupied, passable terrain, inside geofences. */
  isFreeForGround(x: number, y: number): boolean {
    const i = this.cellI(x);
    const j = this.cellJ(y);
    if (this.isBlocked(i, j) || this.terrainCost.get(i, j) === TERRAIN_IMPASSABLE) return false;
    return !this.zones.outsideGeofence(x, y);
  }

  /**
   * Top of whatever occupies cell (i, j) for aerial vehicles, in metres (ADR-0012/0025 additions):
   * - free cell: the ground height;
   * - occupied cell with a recorded height: that height;
   * - occupied cell with unknown height (`heightDm` = 0): `defaultObstacleHeightM`, or +Infinity if unset.
   */
  obstacleTopM(i: number, j: number): number {
    const h = this.groundHeightM(i, j);
    if (this.occupancy.get(i, j) === OCCUPANCY_FREE || h > 0) return h;
    return this.defaultObstacleHeightM ?? Number.POSITIVE_INFINITY;
  }

  /** True if (i, j) is an occupied cell whose height is unknown (the editor marks these distinctly). */
  hasUnknownObstacleHeight(i: number, j: number): boolean {
    return this.occupancy.get(i, j) !== OCCUPANCY_FREE && this.heightDm.get(i, j) === 0;
  }

  /**
   * Free for an aerial vehicle at (x, y, z) (2.5D, ADR-0012): within altitude limits and geofences, not in
   * a no-fly volume, and at least `clearanceM` above the cell's obstacle top (`obstacleTopM`). UAVs ignore
   * terrain cost (ADR-0025).
   */
  isFreeForAir(x: number, y: number, z: number, clearanceM = 0): boolean {
    const i = this.cellI(x);
    const j = this.cellJ(y);
    if (!this.inBounds(i, j)) return false;
    if (z < this.altitudeLimitsM.min || z > this.altitudeLimitsM.max) return false;
    if (this.zones.outsideGeofence(x, y) || this.zones.isNoFly(x, y, z)) return false;
    return z >= this.obstacleTopM(i, j) + clearanceM;
  }

  /** Hierarchical occupancy pyramid, brought up to date with the changed chunks before use. */
  pyramid(): OccupancyPyramid {
    if (!this.pyramidInstance) {
      this.pyramidInstance = new OccupancyPyramid(this.sizeX, this.sizeY, (i, j) => this.isBlocked(i, j), Math.min(6, 31 - Math.clz32(this.chunkSize))); // log2 of a power of two, exactly
      this.pyramidSeen = this.versionCounter;
      return this.pyramidInstance;
    }
    if (this.pyramidSeen !== this.versionCounter) {
      for (const k of this.chunksChangedSince(this.pyramidSeen)) {
        const ci = k % this.chunksX;
        const cj = (k / this.chunksX) | 0;
        const cs = this.chunkSize;
        this.pyramidInstance.rebuildRegion(ci * cs, cj * cs, Math.min(this.sizeX, (ci + 1) * cs), Math.min(this.sizeY, (cj + 1) * cs));
      }
      this.pyramidSeen = this.versionCounter;
    }
    return this.pyramidInstance;
  }

  /**
   * A dense, row-major copy of the occupancy layer (one byte per cell, index j · sizeX + i), brought up to date
   * with the changed chunks before use. For hot loops that read many cells (sensor rays): one array read per
   * cell instead of a chunk lookup. Read-only for callers.
   */
  occupancyDense(): Uint8Array {
    if (!this.denseOccupancy) {
      this.denseOccupancy = new Uint8Array(this.sizeX * this.sizeY);
      this.refreshDense(0, 0, this.sizeX, this.sizeY);
      this.denseSeen = this.versionCounter;
    } else if (this.denseSeen !== this.versionCounter) {
      const cs = this.chunkSize;
      for (const k of this.chunksChangedSince(this.denseSeen)) {
        const ci = k % this.chunksX;
        const cj = (k / this.chunksX) | 0;
        this.refreshDense(ci * cs, cj * cs, Math.min(this.sizeX, (ci + 1) * cs), Math.min(this.sizeY, (cj + 1) * cs));
      }
      this.denseSeen = this.versionCounter;
    }
    return this.denseOccupancy;
  }

  private denseOccupancy: Uint8Array | undefined;
  private denseSeen = 0;

  private refreshDense(i0: number, j0: number, i1: number, j1: number): void {
    const d = this.denseOccupancy as Uint8Array;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) d[j * this.sizeX + i] = this.occupancy.get(i, j);
  }

  /** Canonical state for the state hash (ADR-0023): dimensions, limits, then per-chunk layer hashes. */
  hashInto(h: StateHasher): void {
    h.u32(this.sizeX).u32(this.sizeY).f64(this.resolutionM, "grid.res").u32(this.chunkSize);
    h.f64(this.altitudeLimitsM.min, "grid.altMin").f64(this.altitudeLimitsM.max, "grid.altMax");
    h.f64(this.defaultObstacleHeightM ?? -1, "grid.defaultObstacleHeight"); // -1 = unlimited (absent)
    for (let cj = 0; cj < this.chunksY; cj++) {
      for (let ci = 0; ci < this.chunksX; ci++) {
        h.bytesHash(this.occupancy.chunkHash(ci, cj)).bytesHash(this.terrainCost.chunkHash(ci, cj)).bytesHash(this.heightDm.chunkHash(ci, cj));
      }
    }
    h.u32(this.zones.zones.length);
    for (const z of this.zones.zones) {
      h.str(z.id).str(z.kind).f64(z.minAltM ?? -1e300, `zone.${z.id}.min`).f64(z.maxAltM ?? 1e300, `zone.${z.id}.max`).u32(z.polygon.length);
      for (const [x, y] of z.polygon) h.f64(x, `zone.${z.id}.x`).f64(y, `zone.${z.id}.y`);
    }
  }

  /** Bytes held by materialized chunks across layers (memory report). */
  materializedBytes(): number {
    return this.occupancy.materializedBytes() + this.terrainCost.materializedBytes() + this.heightDm.materializedBytes();
  }
}
