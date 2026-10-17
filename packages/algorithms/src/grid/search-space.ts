import { evaluateCondition, type CompiledExpr } from "@agentsim/core";
import type { PlanningGrid } from "@agentsim/spatial";
import type { CompiledCostProfile } from "../cost-profile.ts";

/** How a vehicle traverses the grid when planning (body parameters; ADR-0024/0028 budgets are separate). */
export interface VehicleTraversal {
  readonly vehicle: "uav" | "ugv";
  /** UAVs plan at a fixed cruise altitude in F1 (variable-altitude planning comes with `altitudeChange`). */
  readonly cruiseAltitudeM: number;
  readonly clearanceM: number;
  readonly speedMps: number;
  readonly energyWhPerM: number;
  /**
   * Horizontal clearance kept from impassable cells and the map border (UGV: footprint + tracking margin;
   * UAV: footprint). A model parameter: it changes paths, so it is part of the view's cache key and of the
   * effective configuration hash. Absent = 0.
   */
  readonly inflationRadiusM?: number;
}

export const SQRT2 = Math.SQRT2;

/**
 * Offsets of the cells whose square lies within `radiusCells` of a cell's centre (strictly: a footprint
 * that only touches an obstacle is allowed). Distance from the centre to the square at (di, dj) is
 * hypot(max(|di| − ½, 0), max(|dj| − ½, 0)) cells; compared squared, so the set is exact.
 */
export function inflationOffsets(radiusCells: number): { offsets: Int32Array; reach: number } {
  if (!(radiusCells > 0)) return { offsets: new Int32Array(0), reach: 0 };
  const k = Math.ceil(radiusCells + 0.5);
  const r2 = radiusCells * radiusCells;
  const out: number[] = [];
  let reach = 0;
  for (let dj = -k; dj <= k; dj++) {
    for (let di = -k; di <= k; di++) {
      if (di === 0 && dj === 0) continue;
      const x = Math.max(Math.abs(di) - 0.5, 0);
      const y = Math.max(Math.abs(dj) - 0.5, 0);
      if (x * x + y * y < r2) {
        out.push(di, dj);
        reach = Math.max(reach, Math.abs(di), Math.abs(dj));
      }
    }
  }
  return { offsets: Int32Array.from(out), reach };
}
/** 8-connected moves: dx, dy for directions 0..7 (E, NE, N, NW, W, SW, S, SE). */
export const DIR_DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIR_DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;

/**
 * Planning view of a grid for one vehicle and cost profile (ADR-0014, ADR-0026): a per-cell traversal mask
 * that already includes cell-only constraints, plus edge costs and an admissible heuristic. Mask byte:
 * 0 = impassable, otherwise the cost code of entering the cell (UGV: terrain cost, 10 = x1.0; UAV: 10), so
 * the search hot loop reads passability and cost from one array.
 * The mask is a precomputed structure (no sim time, ADR-0024); `sync()` refreshes only changed chunks.
 *
 * Live view (ADR-0024 addition of 2026-10-10): one view per (map, traversal, profile), updated in place by `sync()`
 * at the run's fixed sync points only. Each sync stamps the chunks whose view content actually changed, so readers
 * (the read-set check of queries in progress, HPA* graphs) ask `changedSince(contentVersion)`.
 */
export class SearchSpace {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly mask: Uint8Array;
  readonly resolutionM: number;
  /** Lower bound of the cost of one metre of movement (admissible heuristic factor). */
  readonly costPerMetreLowerBound: number;
  /** Cost per metre independent of the cell (distance, time, energy). */
  readonly basePerMetre: number;
  /** Cost per metre per unit of cell cost code (terrain; 0 for UAVs or when terrain has no weight). */
  readonly codePerMetre: number;
  readonly turnWeight: number;
  /** Heuristic multiplier per cell of octile distance. */
  readonly heuristicPerCell: number;
  readonly hasEdgeConstraints: boolean;
  /**
   * Belief views (F2): 1 for cells the agent has never observed, where the cost profile's `unknown` weight
   * multiplies the move cost; null for maps without unknown cells (ground truth), so nothing is paid there.
   */
  readonly unknown: Uint8Array | null;
  /** The cost profile's `unknown` weight (built-in 1). */
  readonly unknownFactor: number;
  /** Mask before inflation (same encoding). */
  private readonly base: Uint8Array;
  /** Cell offsets (di, dj pairs) within the inflation radius, excluding (0, 0). */
  private readonly offsets: Int32Array;
  /** Largest |di| or |dj| in `offsets`: how far inflation reaches, in cells. */
  private readonly reach: number;
  /** Inflation radius in cells. */
  private readonly radiusCells: number;
  private syncedVersion: number;
  /** Bumped by each sync that changed view content; internal (never traced). */
  private contentCounter = 0;
  /** Per chunk: the content version that last changed it. */
  private readonly chunkStamp: Uint32Array;
  private readonly chunkSize: number;
  private readonly chunksX: number;
  /** Scratch: mask and unknown flags of a region before its rebuild (change detection). */
  private beforeMask: Uint8Array = new Uint8Array(0);
  private beforeUnknown: Uint8Array = new Uint8Array(0);
  private readonly cellSlots: Float64Array;
  private readonly edgeSlots: Float64Array;
  private readonly cellVarKinds: string[][];
  private readonly edgeVarKinds: string[][];

  /** New view of `grid`, built from its current content. */
  constructor(
    readonly grid: PlanningGrid,
    readonly traversal: VehicleTraversal,
    readonly profile: CompiledCostProfile,
  ) {
    this.sizeX = grid.sizeX;
    this.sizeY = grid.sizeY;
    this.resolutionM = grid.resolutionM;
    this.mask = new Uint8Array(grid.sizeX * grid.sizeY);
    this.cellVarKinds = profile.cellConstraints.map((c) => [...c.variables]);
    this.edgeVarKinds = profile.edgeConstraints.map((c) => [...c.variables]);
    this.cellSlots = new Float64Array(8);
    this.edgeSlots = new Float64Array(8);
    const w = profile.weights;
    this.basePerMetre = w.distance + w.time / traversal.speedMps + w.energy * traversal.energyWhPerM;
    this.codePerMetre = traversal.vehicle === "ugv" ? w.terrain / 10 : 0;
    this.turnWeight = w.turn;
    this.hasEdgeConstraints = profile.edgeConstraints.length > 0;
    this.unknown = grid.hasUnknown ? new Uint8Array(grid.sizeX * grid.sizeY) : null;
    this.unknownFactor = w.unknown;
    // The smallest code is 1; an unknown weight below 1 lowers the cheapest possible move (admissibility).
    this.costPerMetreLowerBound = (this.basePerMetre + this.codePerMetre) * (this.unknown ? Math.min(1, w.unknown) : 1);
    this.heuristicPerCell = this.costPerMetreLowerBound * grid.resolutionM;
    this.base = new Uint8Array(grid.sizeX * grid.sizeY);
    this.radiusCells = (traversal.inflationRadiusM ?? 0) / grid.resolutionM;
    const { offsets, reach } = inflationOffsets(this.radiusCells);
    this.offsets = offsets;
    this.reach = reach;
    this.chunkSize = grid.chunkSize;
    this.chunksX = grid.chunksX;
    this.chunkStamp = new Uint32Array(grid.chunksX * grid.chunksY);
    this.rebuildRegion(0, 0, grid.sizeX, grid.sizeY);
    this.syncedVersion = grid.version;
  }

  /** Cache key of this view: traversal parameters and profile (grid version tracked separately). */
  static key(t: VehicleTraversal, profile: CompiledCostProfile): string {
    return `${t.vehicle}|${t.cruiseAltitudeM}|${t.clearanceM}|${t.speedMps}|${t.energyWhPerM}|${t.inflationRadiusM ?? 0}|${profile.hash}`;
  }

  /** Version of the map this view was last synced to (the domain of `PlanMap.version`). */
  get version(): number {
    return this.syncedVersion;
  }

  /** Internal content version: moves only when a sync changed the view's content. */
  get contentVersion(): number {
    return this.contentCounter;
  }

  /** Chunks whose view content changed after content version `v`, ascending. */
  changedSince(v: number): number[] {
    const out: number[] = [];
    if (v >= this.contentCounter) return out;
    for (let k = 0; k < this.chunkStamp.length; k++) if ((this.chunkStamp[k] ?? 0) > v) out.push(k);
    return out;
  }

  /**
   * Brings the view up to date with its map, in place; returns the chunks whose view content actually changed
   * (passability, cost code, unknown flag), ascending. Profiles with edge constraints read the map directly
   * when costing moves, so for them every changed map chunk and its neighbours count as changed.
   */
  sync(): number[] {
    if (this.syncedVersion === this.grid.version) return [];
    const g = this.grid;
    const cs = this.chunkSize;
    const k = this.reach;
    const touched = new Uint8Array(this.chunkStamp.length);
    // Belief maps log the cells that changed: refresh only those and their inflation (profiles with edge
    // constraints read the map when costing moves, so they keep the chunk path and its neighbour stamping).
    const cells = this.hasEdgeConstraints ? undefined : g.cellsChangedSince?.(this.syncedVersion);
    if (cells) {
      this.syncCells(cells, touched);
      this.syncedVersion = g.version;
      return this.stamp(touched);
    }
    const changedMap = g.chunksChangedSince(this.syncedVersion);
    for (const c of changedMap) {
      const ci = c % this.chunksX;
      const cj = (c / this.chunksX) | 0;
      // Slope depends on 4-neighbours: refresh a one-cell ring around the chunk as well; inflation reaches k more.
      const i0 = Math.max(0, ci * cs - 1 - k);
      const j0 = Math.max(0, cj * cs - 1 - k);
      const i1 = Math.min(this.sizeX, (ci + 1) * cs + 1 + k);
      const j1 = Math.min(this.sizeY, (cj + 1) * cs + 1 + k);
      this.snapshotRegion(i0, j0, i1, j1);
      this.rebuildRegion(ci * cs - 1, cj * cs - 1, (ci + 1) * cs + 1, (cj + 1) * cs + 1);
      this.diffRegion(i0, j0, i1, j1, touched);
      if (this.hasEdgeConstraints) {
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = ci + di;
            const b = cj + dj;
            if (a >= 0 && b >= 0 && a < this.chunksX && b * this.chunksX + a < touched.length) touched[b * this.chunksX + a] = 1;
          }
        }
      }
    }
    this.syncedVersion = g.version;
    return this.stamp(touched);
  }

  /** Stamps the touched chunks with a new content version (if any); returns them ascending. */
  private stamp(touched: Uint8Array): number[] {
    const out: number[] = [];
    for (let c = 0; c < touched.length; c++) if (touched[c] === 1) out.push(c);
    if (out.length > 0) {
      this.contentCounter++;
      for (const c of out) this.chunkStamp[c] = this.contentCounter;
    }
    return out;
  }

  /**
   * Refreshes the view for a list of changed map cells: their base value and unknown flag (plus the one-cell ring
   * that cell constraints such as slope read), then the inflated mask of every cell within reach of them. Marks the
   * chunk of every cell whose mask, or counted unknown flag, actually changed. Equal to a chunk rebuild.
   */
  private syncCells(changed: Int32Array, touched: Uint8Array): void {
    const sx = this.sizeX;
    const sy = this.sizeY;
    const ring = this.profile.cellConstraints.length > 0 ? 1 : 0;
    const base = new Set<number>();
    for (let n = 0; n < changed.length; n++) {
      const c = changed[n] ?? 0;
      const i = c % sx;
      const j = (c / sx) | 0;
      for (let dj = -ring; dj <= ring; dj++) {
        for (let di = -ring; di <= ring; di++) {
          if (ring > 0 && di !== 0 && dj !== 0) continue; // 4-neighbours
          const a = i + di;
          const b = j + dj;
          if (a >= 0 && b >= 0 && a < sx && b < sy) base.add(b * sx + a);
        }
      }
    }
    const cs = this.chunkSize;
    const unk = this.unknownFactor === 1 ? null : this.unknown;
    for (const c of base) {
      const i = c % sx;
      const j = (c / sx) | 0;
      const before = unk ? unk[c] : 0;
      this.rebuildBase(i, j, i + 1, j + 1);
      if (unk && unk[c] !== before) touched[((j / cs) | 0) * this.chunksX + ((i / cs) | 0)] = 1;
    }
    // The mask of a cell depends on the base values within the inflation reach.
    const k = this.reach;
    const masked = k === 0 ? base : new Set<number>();
    if (k > 0) {
      for (const c of base) {
        const i = c % sx;
        const j = (c / sx) | 0;
        for (let b = Math.max(0, j - k); b <= Math.min(sy - 1, j + k); b++) for (let a = Math.max(0, i - k); a <= Math.min(sx - 1, i + k); a++) masked.add(b * sx + a);
      }
    }
    for (const c of masked) {
      const i = c % sx;
      const j = (c / sx) | 0;
      const v = this.maskAt(i, j);
      if (this.mask[c] === v) continue;
      this.mask[c] = v;
      touched[((j / cs) | 0) * this.chunksX + ((i / cs) | 0)] = 1;
    }
  }

  /** The inflated mask value of one cell: its base value, or 0 if its footprint disk overlaps an impassable cell or the map border. */
  private maskAt(i: number, j: number): number {
    const v = this.base[j * this.sizeX + i] ?? 0;
    if (v === 0 || this.offsets.length === 0) return v;
    const r = this.radiusCells;
    if (i + 0.5 < r || this.sizeX - i - 0.5 < r || j + 0.5 < r || this.sizeY - j - 0.5 < r) return 0;
    const off = this.offsets;
    for (let n = 0; n < off.length; n += 2) {
      const a = i + (off[n] ?? 0);
      const b = j + (off[n + 1] ?? 0);
      if (a >= 0 && b >= 0 && a < this.sizeX && b < this.sizeY && this.base[b * this.sizeX + a] === 0) return 0;
    }
    return v;
  }

  private snapshotRegion(i0: number, j0: number, i1: number, j1: number): void {
    const w = i1 - i0;
    const n = w * (j1 - j0);
    if (this.beforeMask.length < n) {
      this.beforeMask = new Uint8Array(n);
      this.beforeUnknown = new Uint8Array(n);
    }
    for (let j = j0; j < j1; j++) {
      this.beforeMask.set(this.mask.subarray(j * this.sizeX + i0, j * this.sizeX + i1), (j - j0) * w);
      if (this.unknown) this.beforeUnknown.set(this.unknown.subarray(j * this.sizeX + i0, j * this.sizeX + i1), (j - j0) * w);
    }
  }

  /** Marks the chunk of every cell of the region whose mask or unknown flag differs from the snapshot. */
  private diffRegion(i0: number, j0: number, i1: number, j1: number, touched: Uint8Array): void {
    const w = i1 - i0;
    const cs = this.chunkSize;
    // With an `unknown` weight of 1 the flag changes no cost: unknown → free is no planning change (ADR-0024).
    const unk = this.unknownFactor === 1 ? null : this.unknown;
    for (let j = j0; j < j1; j++) {
      const row = (j - j0) * w;
      const base = j * this.sizeX;
      for (let i = i0; i < i1; i++) {
        const n = base + i;
        if (this.mask[n] === this.beforeMask[row + i - i0] && (unk === null || unk[n] === this.beforeUnknown[row + i - i0])) continue;
        touched[((j / cs) | 0) * this.chunksX + ((i / cs) | 0)] = 1;
      }
    }
  }

  /**
   * Distance from (x, y) to the nearest cell this vehicle cannot occupy in the planner's map (base mask,
   * before footprint inflation) or to the map edge, capped at `maxM`. Exact against cell squares.
   */
  clearanceM(x: number, y: number, maxM: number): number {
    const res = this.resolutionM;
    let best = Math.min(maxM, x, y, this.sizeX * res - x, this.sizeY * res - y);
    if (best <= 0) return 0;
    const reach = Math.ceil(best / res);
    const ci = Math.floor(x / res);
    const cj = Math.floor(y / res);
    for (let j = Math.max(0, cj - reach); j <= Math.min(this.sizeY - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(this.sizeX - 1, ci + reach); i++) {
        if (this.base[j * this.sizeX + i] !== 0) continue;
        const dx = Math.max(i * res - x, 0, x - (i + 1) * res);
        const dy = Math.max(j * res - y, 0, y - (j + 1) * res);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
    }
    return best;
  }

  passable(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.sizeX && j < this.sizeY && this.mask[j * this.sizeX + i] !== 0;
  }

  /** Recomputes the base mask in the region, then the inflated mask wherever the change can reach. */
  private rebuildRegion(i0: number, j0: number, i1: number, j1: number): void {
    this.rebuildBase(i0, j0, i1, j1);
    const k = this.reach;
    this.inflate(i0 - k, j0 - k, i1 + k, j1 + k);
  }

  /**
   * mask = base, then every cell whose footprint disk overlaps an impassable cell or the map border is
   * blocked. Only boundary impassable cells (with a passable 8-neighbour) need to stamp their disk: the
   * nearest impassable cell to any passable cell is a boundary cell.
   */
  private inflate(i0: number, j0: number, i1: number, j1: number): void {
    const a0 = Math.max(0, i0);
    const b0 = Math.max(0, j0);
    const a1 = Math.min(this.sizeX, i1);
    const b1 = Math.min(this.sizeY, j1);
    const sx = this.sizeX;
    const base = this.base;
    const mask = this.mask;
    for (let j = b0; j < b1; j++) mask.set(base.subarray(j * sx + a0, j * sx + a1), j * sx + a0);
    if (this.offsets.length === 0) return;
    const r = this.radiusCells;
    // Map border: the outside counts as impassable.
    for (let j = b0; j < b1; j++) {
      for (let i = a0; i < a1; i++) {
        if (i + 0.5 < r || sx - i - 0.5 < r || j + 0.5 < r || this.sizeY - j - 0.5 < r) mask[j * sx + i] = 0;
      }
    }
    const k = this.reach;
    const off = this.offsets;
    const s0 = Math.max(0, a0 - k);
    const t0 = Math.max(0, b0 - k);
    const s1 = Math.min(sx, a1 + k);
    const t1 = Math.min(this.sizeY, b1 + k);
    for (let j = t0; j < t1; j++) {
      for (let i = s0; i < s1; i++) {
        if (base[j * sx + i] !== 0 || !this.hasPassableNeighbour(i, j)) continue;
        for (let n = 0; n < off.length; n += 2) {
          const ni = i + (off[n] ?? 0);
          const nj = j + (off[n + 1] ?? 0);
          if (ni >= a0 && nj >= b0 && ni < a1 && nj < b1) mask[nj * sx + ni] = 0;
        }
      }
    }
  }

  private hasPassableNeighbour(i: number, j: number): boolean {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ni = i + di;
        const nj = j + dj;
        if ((di !== 0 || dj !== 0) && ni >= 0 && nj >= 0 && ni < this.sizeX && nj < this.sizeY && this.base[nj * this.sizeX + ni] !== 0) return true;
      }
    }
    return false;
  }

  private rebuildBase(i0: number, j0: number, i1: number, j1: number): void {
    const a0 = Math.max(0, i0);
    const b0 = Math.max(0, j0);
    const a1 = Math.min(this.sizeX, i1);
    const b1 = Math.min(this.sizeY, j1);
    const g = this.grid;
    const t = this.traversal;
    const hasZones = g.zones.zones.length > 0;
    for (let j = b0; j < b1; j++) {
      for (let i = a0; i < a1; i++) {
        let ok: boolean;
        if (t.vehicle === "ugv") {
          ok = !g.isBlocked(i, j) && g.terrainAt(i, j) > 0 && (!hasZones || !g.zones.outsideGeofence(g.cellCenterX(i), g.cellCenterY(j)));
        } else {
          // The rule of GridSpace.isFreeForAir, on the planning grid: within the altitude limits, inside the
          // geofences and outside no-fly volumes, and at least the clearance above the cell's obstacle top.
          const alt = t.cruiseAltitudeM;
          ok = alt >= g.altitudeLimitsM.min && alt <= g.altitudeLimitsM.max && alt >= g.obstacleTopM(i, j) + t.clearanceM;
          if (ok && hasZones) {
            const x = g.cellCenterX(i);
            const y = g.cellCenterY(j);
            ok = !g.zones.outsideGeofence(x, y) && !g.zones.isNoFly(x, y, alt);
          }
        }
        if (ok && this.profile.cellConstraints.length > 0) ok = this.cellConstraintsHold(i, j);
        const n = j * this.sizeX + i;
        this.base[n] = ok ? (t.vehicle === "ugv" ? g.terrainAt(i, j) : 10) : 0;
        if (this.unknown) this.unknown[n] = g.isUnknown(i, j) ? 1 : 0;
      }
    }
  }

  private cellVar(name: string, i: number, j: number): number {
    const g = this.grid;
    switch (name) {
      case "altitude":
        return this.traversal.vehicle === "uav" ? this.traversal.cruiseAltitudeM : g.groundHeightM(i, j);
      case "terrain":
        return g.terrainAt(i, j) / 10;
      case "slope": {
        const h = g.groundHeightM(i, j);
        let s = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (g.inBounds(ni, nj)) s = Math.max(s, Math.abs(g.groundHeightM(ni, nj) - h) / this.resolutionM);
        }
        return s;
      }
      case "vehicle":
        return this.traversal.vehicle === "uav" ? 0 : 1;
      default:
        return Number.NaN;
    }
  }

  private cellConstraintsHold(i: number, j: number): boolean {
    const cs = this.profile.cellConstraints;
    for (let c = 0; c < cs.length; c++) {
      const kinds = this.cellVarKinds[c] ?? [];
      for (let s = 0; s < kinds.length; s++) this.cellSlots[s] = this.cellVar(kinds[s] ?? "", i, j);
      if (!evaluateCondition(cs[c] as CompiledExpr, this.cellSlots)) return false;
    }
    return true;
  }

  /**
   * Cost of moving from (i, j) to its neighbour in direction `dir`, with `turnRad` of heading change;
   * +Infinity if an edge constraint is violated (fails closed). Caller has checked passability.
   */
  moveCost(i: number, j: number, dir: number, turnRad: number): number {
    const diag = (dir & 1) === 1;
    const len = this.resolutionM * (diag ? SQRT2 : 1);
    const ti = i + (DIR_DX[dir] ?? 0);
    const tj = j + (DIR_DY[dir] ?? 0);
    // Same expression (and evaluation order) as the inlined hot loop in GridSearch: keep them identical.
    const n = tj * this.sizeX + ti;
    let perMetre = this.basePerMetre + this.codePerMetre * (this.mask[n] ?? 0);
    if (this.unknown && this.unknown[n] === 1) perMetre *= this.unknownFactor;
    const c = len * perMetre + this.turnWeight * turnRad;
    if (!this.hasEdgeConstraints) return c;
    const ecs = this.profile.edgeConstraints;
    for (let e = 0; e < ecs.length; e++) {
      const kinds = this.edgeVarKinds[e] ?? [];
      for (let s = 0; s < kinds.length; s++) {
        const k = kinds[s] ?? "";
        this.edgeSlots[s] = k === "distance" ? len : k === "turn" ? turnRad : this.cellVar(k, ti, tj);
      }
      if (!evaluateCondition(ecs[e] as CompiledExpr, this.edgeSlots)) return Number.POSITIVE_INFINITY;
    }
    return c;
  }

  /** True if the diagonal/straight move is allowed: target passable and no corner cutting. */
  canMove(i: number, j: number, dir: number): boolean {
    const dx = DIR_DX[dir] ?? 0;
    const dy = DIR_DY[dir] ?? 0;
    if (!this.passable(i + dx, j + dy)) return false;
    if (dx !== 0 && dy !== 0) return this.passable(i + dx, j) && this.passable(i, j + dy);
    return true;
  }

  /** Admissible octile heuristic in cost units between two cells. */
  heuristic(i0: number, j0: number, i1: number, j1: number): number {
    const dx = Math.abs(i1 - i0);
    const dy = Math.abs(j1 - j0);
    const lo = Math.min(dx, dy);
    return (Math.max(dx, dy) - lo + SQRT2 * lo) * this.heuristicPerCell;
  }

  /**
   * Euclidean heuristic in cost units (ADR-0037 addition of 2026-10-13, §7): the straight-line distance in cells times the
   * same profile-scaled factor as the octile one. Never above it on an 8-connected grid, so admissible wherever octile is.
   * `Math.sqrt` is correctly rounded (unlike `Math.hypot`), so the value is the same on every machine.
   */
  heuristicEuclidean(i0: number, j0: number, i1: number, j1: number): number {
    const dx = i1 - i0;
    const dy = j1 - j0;
    return Math.sqrt(dx * dx + dy * dy) * this.heuristicPerCell;
  }
}
