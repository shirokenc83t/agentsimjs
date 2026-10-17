import { CELL_BLOCKED, CELL_UNKNOWN, type PlanningGrid } from "../grid/planning-grid.ts";
import { pointInPolygon, type Zone } from "../zones.ts";

/**
 * Topological layer v0, `grid-sectors-v0` (ADR-0039): fixed square regions aligned with the chunk grid, frontier
 * groups per region, waypoints and region connectivity, built from one agent's planning grid (its belief grid, or
 * the ground truth for `ideal` agents). Deterministic: integer counts, cells by index, regions by ID.
 */

export interface TopologyConfig {
  readonly abstraction: "grid-sectors-v0";
  /** Region side in chunks, [1, 16]. */
  readonly regionChunks: number;
  readonly maxRegions: number;
  readonly maxFrontiers: number;
  readonly minFrontierCells: number;
}

export const DEFAULT_TOPOLOGY: TopologyConfig = { abstraction: "grid-sectors-v0", regionChunks: 4, maxRegions: 16, maxFrontiers: 8, minFrontierCells: 4 };

export const TOPOLOGY_LIMITS = {
  regionChunks: [1, 16],
  maxRegions: [1, 64],
  maxFrontiers: [0, 32],
  minFrontierCells: [1, 1024],
} as const;

/** What connectivity reads: the agent's planning view (passability after inflation, altitude and profile). */
export interface PassabilityView {
  /** Identifies the view's traversal and profile: a different key makes every edge dirty. */
  readonly key: string;
  passable(i: number, j: number): boolean;
}

export type EdgeClass = "open" | "unexplored";

export interface RegionInfo {
  readonly id: string;
  readonly col: number;
  readonly row: number;
  /** Cell bounds, half-open: [i0, i1) × [j0, j1). */
  readonly i0: number;
  readonly j0: number;
  readonly i1: number;
  readonly j1: number;
  readonly cells: number;
  readonly known: number;
  readonly free: number;
  readonly occupied: number;
  /** Ids of zones intersecting the region, sorted. */
  readonly zones: readonly string[];
}

export interface FrontierGroup {
  readonly id: string;
  readonly region: string;
  /** Cell indices (j · sizeX + i), ascending. */
  readonly cells: readonly number[];
  /** Representative cell: nearest to the group's centroid, ties by index. */
  readonly point: number;
}

export interface RegionEdge {
  readonly a: string;
  readonly b: string;
  readonly cls: EdgeClass;
}

/** Halo class for cells beyond the map: never unknown, never free. */
const OUTSIDE = 3;

/** Waypoint memo states (cell indices are >= 0). */
const WP_STALE = -2;
const WP_NONE = -1;

const CLS_NONE = 0;
const CLS_UNEXPLORED = 1;
const CLS_OPEN = 2;

/** One agent's topological layer, maintained incrementally from the planning grid's dirty chunks. */
export class AgentTopology {
  readonly regionsX: number;
  readonly regionsY: number;
  private readonly regionCells: number;
  private readonly cs: number;
  private readonly chunksX: number;
  private readonly chunksY: number;
  private readonly idWidth: number;
  private gridVersion = -1;
  // Per chunk: counts of known, free and occupied cells, and its frontier cells (ascending).
  private readonly chunkKnown: Int32Array;
  private readonly chunkFree: Int32Array;
  private readonly chunkOccupied: Int32Array;
  /** Frontier flags per chunk (chunkSize² bits as bytes), allocated at the chunk's first frontier cell. */
  private readonly chunkFrontier: (Uint8Array | undefined)[];
  private readonly chunkFrontierCount: Int32Array;
  /** Scratch: one chunk's cell classes. */
  private readonly cls: Uint8Array;
  /** Scratch: one chunk's new frontier flags. */
  private readonly nextBits: Uint8Array;
  /** Scratch: a chunk's classes with a one-cell halo, (chunkSize + 2)² (halo: unknown or not). */
  private readonly halo: Uint8Array;
  /** Per chunk: its frontier cells (global indices, ascending), rebuilt from the flags when stale. */
  private readonly chunkList: (Int32Array | undefined)[];
  private readonly listStale: Uint8Array;
  /** Scratch for grouping: a region's frontier cells, and the flood-fill stack. */
  private readonly cellScratch: Int32Array;
  private readonly stackScratch: Int32Array;
  // Per region: frontier groups (recomputed when a chunk of the region is dirty).
  private readonly groups: FrontierGroup[][];
  /** Regions whose frontier flags changed since they were last grouped. */
  private readonly groupsStale: Uint8Array;
  /** Per region: bumped whenever its frontier flags change (the groups of a region with an unchanged stamp are unchanged). */
  private readonly regionRev: Uint32Array;
  /** Counts updates that changed a frontier flag somewhere: a cheap change stamp for watchers of the frontier groups. */
  private frontierRev = 0;
  /** Memo of each region's waypoint cell (see `waypoint`): WP_STALE until computed, WP_NONE when it has none. */
  private readonly wpCell: Int32Array;
  private readonly regionZones: string[][];
  // Edges: right neighbour (index 2r) and upper neighbour (2r + 1) of each region; class and dirty flag.
  private readonly edgeClass: Uint8Array;
  private readonly edgeDirty: Uint8Array;
  private viewKey: string | undefined;
  // Scratch for grouping (one region at a time).
  private readonly label: Int32Array;

  constructor(
    readonly grid: PlanningGrid,
    readonly config: TopologyConfig,
  ) {
    const g = grid;
    this.cs = g.chunkSize;
    this.chunksX = g.chunksX;
    this.chunksY = g.chunksY;
    this.regionCells = config.regionChunks * g.chunkSize;
    this.regionsX = Math.ceil(g.sizeX / this.regionCells);
    this.regionsY = Math.ceil(g.sizeY / this.regionCells);
    this.idWidth = Math.max(2, String(Math.max(this.regionsX, this.regionsY) - 1).length);
    const nChunks = this.chunksX * this.chunksY;
    this.chunkKnown = new Int32Array(nChunks);
    this.chunkFree = new Int32Array(nChunks);
    this.chunkOccupied = new Int32Array(nChunks);
    this.chunkFrontier = new Array<Uint8Array | undefined>(nChunks).fill(undefined);
    this.chunkFrontierCount = new Int32Array(nChunks);
    this.cls = new Uint8Array(g.chunkSize * g.chunkSize);
    this.nextBits = new Uint8Array(g.chunkSize * g.chunkSize);
    this.halo = new Uint8Array((g.chunkSize + 2) * (g.chunkSize + 2));
    this.chunkList = new Array<Int32Array | undefined>(nChunks).fill(undefined);
    this.listStale = new Uint8Array(nChunks);
    const nRegions = this.regionsX * this.regionsY;
    this.groups = Array.from({ length: nRegions }, () => []);
    this.groupsStale = new Uint8Array(nRegions);
    this.regionRev = new Uint32Array(nRegions);
    this.wpCell = new Int32Array(nRegions).fill(WP_STALE);
    this.regionZones = Array.from({ length: nRegions }, (_, r) => this.zonesOf(r));
    this.edgeClass = new Uint8Array(2 * nRegions);
    this.edgeDirty = new Uint8Array(2 * nRegions).fill(1);
    this.label = new Int32Array(this.regionCells * this.regionCells);
    this.cellScratch = new Int32Array(this.regionCells * this.regionCells);
    this.stackScratch = new Int32Array(this.regionCells * this.regionCells);
  }

  /** Region ID from its position: `r-<col>-<row>`, zero-padded; stable for the whole run. */
  regionId(col: number, row: number): string {
    return `r-${String(col).padStart(this.idWidth, "0")}-${String(row).padStart(this.idWidth, "0")}`;
  }

  regionOfCell(i: number, j: number): number {
    return ((j / this.regionCells) | 0) * this.regionsX + ((i / this.regionCells) | 0);
  }

  /**
   * Brings counts, frontier cells and groups up to the grid's version; marks touched edges dirty. A dirty chunk is
   * recomputed in full; its 4-neighbours only along the line of cells next to it (a frontier flag depends on the
   * 4-neighbours only).
   */
  update(): void {
    const g = this.grid;
    if (g.version === this.gridVersion) return;
    const all = this.gridVersion < 0;
    const nChunks = this.chunksX * this.chunksY;
    const dirty = all ? Array.from({ length: nChunks }, (_, k) => k) : g.chunksChangedSince(this.gridVersion);
    this.gridVersion = g.version;
    if (dirty.length === 0) return;
    const isDirty = new Uint8Array(nChunks);
    for (const k of dirty) isDirty[k] = 1;
    const regions = new Uint8Array(this.regionsX * this.regionsY);
    for (const k of dirty) {
      const ci = k % this.chunksX;
      const cj = (k / this.chunksX) | 0;
      this.wpCell[this.regionOfChunk(ci, cj)] = WP_STALE; // a recount can change which cells are known and free
      // Groups depend only on frontier flags: a region is regrouped only if one changed (sensing noise near walls
      // changes cell classes every tick without moving the frontier).
      if (this.recountChunk(k)) regions[this.regionOfChunk(ci, cj)] = 1;
      // Inflation and cell constraints reach at most a chunk: edges of the regions around a dirty chunk.
      this.markEdgesNear(ci, cj);
    }
    for (const k of dirty) {
      const ci = k % this.chunksX;
      const cj = (k / this.chunksX) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = ci + di;
        const b = cj + dj;
        if (a < 0 || b < 0 || a >= this.chunksX || b >= this.chunksY || isDirty[b * this.chunksX + a] === 1) continue;
        if (this.refreshBorder(a, b, -di, -dj)) regions[this.regionOfChunk(a, b)] = 1;
      }
    }
    for (let r = 0; r < regions.length; r++) {
      if (regions[r] !== 1) continue;
      this.groupsStale[r] = 1;
      this.regionRev[r] = (this.regionRev[r] ?? 0) + 1;
      this.frontierRev++;
    }
  }

  /** Changes whenever the frontier groups of some region may have changed (not on other map updates). */
  get frontierRevision(): number {
    return this.frontierRev;
  }

  private regionOfChunk(ci: number, cj: number): number {
    const rc = this.config.regionChunks;
    return ((cj / rc) | 0) * this.regionsX + ((ci / rc) | 0);
  }

  /** Region statistics, by region index (row-major). */
  regions(): RegionInfo[] {
    const out: RegionInfo[] = [];
    for (let r = 0; r < this.regionsX * this.regionsY; r++) out.push(this.region(r));
    return out;
  }

  region(r: number): RegionInfo {
    const col = r % this.regionsX;
    const row = (r / this.regionsX) | 0;
    const i0 = col * this.regionCells;
    const j0 = row * this.regionCells;
    const i1 = Math.min(this.grid.sizeX, i0 + this.regionCells);
    const j1 = Math.min(this.grid.sizeY, j0 + this.regionCells);
    let known = 0;
    let free = 0;
    let occupied = 0;
    const rc = this.config.regionChunks;
    for (let cj = row * rc; cj < Math.min(this.chunksY, (row + 1) * rc); cj++) {
      for (let ci = col * rc; ci < Math.min(this.chunksX, (col + 1) * rc); ci++) {
        const k = cj * this.chunksX + ci;
        known += this.chunkKnown[k] ?? 0;
        free += this.chunkFree[k] ?? 0;
        occupied += this.chunkOccupied[k] ?? 0;
      }
    }
    return { id: this.regionId(col, row), col, row, i0, j0, i1, j1, cells: (i1 - i0) * (j1 - j0), known, free, occupied, zones: this.regionZones[r] ?? [] };
  }

  /** Whether a cell (j · sizeX + i) is a frontier cell (known free, 4-adjacent to unknown), as of the last update. */
  isFrontierCell(cell: number): boolean {
    const sx = this.grid.sizeX;
    const i = cell % sx;
    const j = (cell / sx) | 0;
    const cs = this.cs;
    const ci = (i / cs) | 0;
    const cj = (j / cs) | 0;
    const bits = this.chunkFrontier[cj * this.chunksX + ci];
    return bits !== undefined && bits[(j - cj * cs) * cs + (i - ci * cs)] === 1;
  }

  /** Number of regions. */
  get regionCount(): number {
    return this.groups.length;
  }

  /** Stamp of a region's frontier flags: unchanged means its frontier groups are unchanged. */
  regionRevision(r: number): number {
    return this.regionRev[r] ?? 0;
  }

  /** Frontier groups of one region (regrouped now if its flags changed; other regions are left alone). */
  groupsOfRegion(r: number): readonly FrontierGroup[] {
    if (this.groupsStale[r] === 1) {
      this.regroup(r);
      this.groupsStale[r] = 0;
    }
    return this.groups[r] ?? [];
  }

  /** Frontier groups of every region, regions by index, groups by lowest cell. */
  frontierGroups(): FrontierGroup[] {
    // Grouping is lazy: only regions whose frontier flags changed since they were last grouped.
    for (let r = 0; r < this.groups.length; r++) {
      if (this.groupsStale[r] === 0) continue;
      this.regroup(r);
      this.groupsStale[r] = 0;
    }
    return this.groups.flat();
  }

  /**
   * Region edges against the agent's current planning view: dirty edges (touched by a changed chunk, or every edge
   * when the view's key changed) are recomputed now. Sorted by region index of `a`, right edge before upper edge.
   */
  edges(view: PassabilityView): RegionEdge[] {
    if (view.key !== this.viewKey) {
      this.edgeDirty.fill(1);
      this.viewKey = view.key;
    }
    const out: RegionEdge[] = [];
    for (let e = 0; e < this.edgeClass.length; e++) {
      if (this.edgeDirty[e] === 1) {
        this.edgeClass[e] = this.crossing(e, view);
        this.edgeDirty[e] = 0;
      }
      const c = this.edgeClass[e] ?? CLS_NONE;
      if (c === CLS_NONE) continue;
      const r = e >> 1;
      const col = r % this.regionsX;
      const row = (r / this.regionsX) | 0;
      const [nc, nr] = (e & 1) === 0 ? [col + 1, row] : [col, row + 1];
      out.push({ a: this.regionId(col, row), b: this.regionId(nc, nr), cls: c === CLS_OPEN ? "open" : "unexplored" });
    }
    return out;
  }

  /**
   * The region's known-free cell nearest to its centre (ties by index), or undefined. Computed on demand and
   * memoized per region until one of its chunks is recounted: a memo only, so asking never changes anything else
   * (ADR-0039 addition of 2026-10-10: laziness is observationally pure).
   */
  waypoint(r: number): number | undefined {
    const cached = this.wpCell[r] ?? WP_STALE;
    if (cached !== WP_STALE) return cached === WP_NONE ? undefined : cached;
    const found = this.scanWaypoint(r);
    this.wpCell[r] = found ?? WP_NONE;
    return found;
  }

  private scanWaypoint(r: number): number | undefined {
    const g = this.grid;
    const reg = this.region(r);
    if (reg.free === 0) return undefined;
    // Twice the centre, so distances stay integers.
    const cx2 = reg.i0 + reg.i1 - 1;
    const cy2 = reg.j0 + reg.j1 - 1;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let j = reg.j0; j < reg.j1; j++) {
      for (let i = reg.i0; i < reg.i1; i++) {
        if (g.isUnknown(i, j) || g.isBlocked(i, j)) continue;
        const dx = 2 * i - cx2;
        const dy = 2 * j - cy2;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = j * g.sizeX + i;
        }
      }
    }
    return best < 0 ? undefined : best;
  }

  /** Recounts a chunk's classes and frontier flags; returns whether any frontier flag changed. */
  private recountChunk(k: number): boolean {
    const g = this.grid;
    const cs = this.cs;
    const ci = k % this.chunksX;
    const cj = (k / this.chunksX) | 0;
    const i0 = ci * cs;
    const j0 = cj * cs;
    const w = Math.min(g.sizeX, i0 + cs) - i0;
    const h = Math.min(g.sizeY, j0 + cs) - j0;
    const cls = this.cls;
    const prev = this.chunkFrontier[k];
    const hadFrontier = (this.chunkFrontierCount[k] ?? 0) > 0;
    if (!g.classifyChunk(ci, cj, cls)) {
      // Never observed: all unknown, no frontier cell.
      this.chunkKnown[k] = 0;
      this.chunkFree[k] = 0;
      this.chunkOccupied[k] = 0;
      prev?.fill(0);
      this.chunkFrontierCount[k] = 0;
      if (hadFrontier) this.listStale[k] = 1;
      return hadFrontier;
    }
    // Classes with a halo: interior from the chunk, halo cells from the grid (only whether they are unknown);
    // cells beyond the map are OUTSIDE (never unknown).
    const W = cs + 2;
    const hb = this.halo;
    hb.fill(OUTSIDE);
    for (let lj = 0; lj < h; lj++) {
      const src = lj * cs;
      const dst = (lj + 1) * W + 1;
      for (let li = 0; li < w; li++) hb[dst + li] = cls[src + li] ?? OUTSIDE;
    }
    for (let li = -1; li <= w; li++) {
      if (this.unknownAt(i0 + li, j0 - 1)) hb[li + 1] = CELL_UNKNOWN;
      if (this.unknownAt(i0 + li, j0 + h)) hb[(h + 1) * W + li + 1] = CELL_UNKNOWN;
    }
    for (let lj = 0; lj < h; lj++) {
      if (this.unknownAt(i0 - 1, j0 + lj)) hb[(lj + 1) * W] = CELL_UNKNOWN;
      if (this.unknownAt(i0 + w, j0 + lj)) hb[(lj + 1) * W + w + 1] = CELL_UNKNOWN;
    }
    let known = 0;
    let occupied = 0;
    let fcount = 0;
    const next = this.nextBits;
    next.fill(0);
    for (let lj = 0; lj < h; lj++) {
      let x = (lj + 1) * W + 1;
      for (let li = 0; li < w; li++, x++) {
        const c = hb[x];
        if (c === CELL_UNKNOWN) continue;
        known++;
        if (c === CELL_BLOCKED) {
          occupied++;
          continue;
        }
        if (hb[x + 1] === CELL_UNKNOWN || hb[x - 1] === CELL_UNKNOWN || hb[x + W] === CELL_UNKNOWN || hb[x - W] === CELL_UNKNOWN) {
          next[lj * cs + li] = 1;
          fcount++;
        }
      }
    }
    this.chunkKnown[k] = known;
    this.chunkFree[k] = known - occupied;
    this.chunkOccupied[k] = occupied;
    this.chunkFrontierCount[k] = fcount;
    let changed: boolean;
    if (!prev) changed = fcount > 0;
    else {
      changed = false;
      for (let n = 0; n < next.length; n++) {
        if (prev[n] !== next[n]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      (prev ?? (this.chunkFrontier[k] = new Uint8Array(cs * cs))).set(next);
      this.listStale[k] = 1;
    }
    return changed;
  }

  /**
   * Recomputes the frontier flags of chunk (ci, cj) along its edge facing direction (di, dj), whose neighbour
   * chunk changed. Returns whether any flag changed.
   */
  private refreshBorder(ci: number, cj: number, di: number, dj: number): boolean {
    const g = this.grid;
    const cs = this.cs;
    const k = cj * this.chunksX + ci;
    const i0 = ci * cs;
    const j0 = cj * cs;
    const w = Math.min(g.sizeX, i0 + cs) - i0;
    const h = Math.min(g.sizeY, j0 + cs) - j0;
    const n = di !== 0 ? h : w;
    let changed = false;
    for (let t = 0; t < n; t++) {
      const li = di > 0 ? w - 1 : di < 0 ? 0 : t;
      const lj = dj > 0 ? h - 1 : dj < 0 ? 0 : t;
      const i = i0 + li;
      const j = j0 + lj;
      const f = !g.isUnknown(i, j) && !g.isBlocked(i, j) && (this.unknownAt(i + 1, j) || this.unknownAt(i - 1, j) || this.unknownAt(i, j + 1) || this.unknownAt(i, j - 1));
      const bits = this.chunkFrontier[k];
      const was = bits !== undefined && bits[lj * cs + li] === 1;
      if (f === was) continue;
      changed = true;
      const b = bits ?? (this.chunkFrontier[k] = new Uint8Array(cs * cs));
      b[lj * cs + li] = f ? 1 : 0;
      this.listStale[k] = 1;
      this.chunkFrontierCount[k] = (this.chunkFrontierCount[k] ?? 0) + (f ? 1 : -1);
    }
    return changed;
  }

  private unknownAt(i: number, j: number): boolean {
    return this.grid.inBounds(i, j) && this.grid.isUnknown(i, j);
  }

  /** A chunk's frontier cells (global indices, ascending), rebuilt from its flags when stale. */
  private frontierList(k: number): Int32Array | undefined {
    if ((this.chunkFrontierCount[k] ?? 0) === 0) return undefined;
    const bits = this.chunkFrontier[k];
    if (!bits) return undefined;
    let list = this.chunkList[k];
    if (this.listStale[k] === 1 || !list) {
      const cs = this.cs;
      const sx = this.grid.sizeX;
      const ci = k % this.chunksX;
      const cj = (k / this.chunksX) | 0;
      list = new Int32Array(this.chunkFrontierCount[k] ?? 0);
      let m = 0;
      for (let n = 0; n < bits.length; n++) if (bits[n] === 1) list[m++] = (cj * cs + ((n / cs) | 0)) * sx + ci * cs + (n % cs);
      this.chunkList[k] = list;
      this.listStale[k] = 0;
    }
    return list;
  }

  /** Frontier cells of the region grouped by 8-connectivity; groups below `minFrontierCells` dropped. */
  private regroup(r: number): void {
    const g = this.grid;
    const sx = g.sizeX;
    const col = r % this.regionsX;
    const row = (r / this.regionsX) | 0;
    const rc = this.config.regionChunks;
    const all = this.cellScratch;
    let n = 0;
    for (let cj = row * rc; cj < Math.min(this.chunksY, (row + 1) * rc); cj++) {
      for (let ci = col * rc; ci < Math.min(this.chunksX, (col + 1) * rc); ci++) {
        const list = this.frontierList(cj * this.chunksX + ci);
        if (!list) continue;
        all.set(list, n);
        n += list.length;
      }
    }
    const out: FrontierGroup[] = [];
    if (n > 0) {
      const cells = all.subarray(0, n).sort();
      const ri0 = col * this.regionCells;
      const rj0 = row * this.regionCells;
      const w = this.regionCells;
      const ri1 = Math.min(sx, ri0 + w);
      const rj1 = Math.min(g.sizeY, rj0 + w);
      const lab = this.label;
      for (let t = 0; t < n; t++) {
        const c = cells[t] ?? 0;
        lab[(((c / sx) | 0) - rj0) * w + ((c % sx) - ri0)] = -1; // frontier, unlabelled
      }
      const id = this.regionId(col, row);
      const stack = this.stackScratch;
      let gid = 0;
      for (let t = 0; t < n; t++) {
        const seed = cells[t] ?? 0;
        const sl = (((seed / sx) | 0) - rj0) * w + ((seed % sx) - ri0);
        if (lab[sl] !== -1) continue;
        const members: number[] = [];
        lab[sl] = 1;
        let top = 0;
        stack[top++] = seed;
        while (top > 0) {
          const c = stack[--top] ?? 0;
          members.push(c);
          const ci = c % sx;
          const cj = (c / sx) | 0;
          for (let nj = Math.max(rj0, cj - 1); nj <= Math.min(rj1 - 1, cj + 1); nj++) {
            for (let ni = Math.max(ri0, ci - 1); ni <= Math.min(ri1 - 1, ci + 1); ni++) {
              const l = (nj - rj0) * w + (ni - ri0);
              if (lab[l] !== -1) continue;
              lab[l] = 1;
              stack[top++] = nj * sx + ni;
            }
          }
        }
        if (members.length < this.config.minFrontierCells) continue;
        members.sort((a, b) => a - b);
        out.push({ id: `f-${id}-${++gid}`, region: id, cells: members, point: representative(members, sx) });
      }
      for (let t = 0; t < n; t++) {
        const c = cells[t] ?? 0;
        lab[(((c / sx) | 0) - rj0) * w + ((c % sx) - ri0)] = 0;
      }
    }
    this.groups[r] = out;
  }

  private markEdgesNear(ci: number, cj: number): void {
    const rc = this.config.regionChunks;
    // Regions of the chunk and its 8 neighbours; each marks its right and upper edge, and the edges into it.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = ci + di;
        const b = cj + dj;
        if (a < 0 || b < 0 || a >= this.chunksX || b >= this.chunksY) continue;
        const col = (a / rc) | 0;
        const row = (b / rc) | 0;
        const r = row * this.regionsX + col;
        this.edgeDirty[2 * r] = 1;
        this.edgeDirty[2 * r + 1] = 1;
        if (col > 0) this.edgeDirty[2 * (r - 1)] = 1;
        if (row > 0) this.edgeDirty[2 * (r - this.regionsX) + 1] = 1;
      }
    }
  }

  /** Class of an edge: a passable 4-adjacent cell pair across the border, `open` if some pair is known free. */
  private crossing(e: number, view: PassabilityView): number {
    const g = this.grid;
    const r = e >> 1;
    const col = r % this.regionsX;
    const row = (r / this.regionsX) | 0;
    const w = this.regionCells;
    let cls = CLS_NONE;
    if ((e & 1) === 0) {
      if (col + 1 >= this.regionsX) return CLS_NONE;
      const i = (col + 1) * w - 1;
      for (let j = row * w; j < Math.min(g.sizeY, (row + 1) * w); j++) {
        if (!view.passable(i, j) || !view.passable(i + 1, j)) continue;
        if (this.knownFree(i, j) && this.knownFree(i + 1, j)) return CLS_OPEN;
        cls = CLS_UNEXPLORED;
      }
    } else {
      if (row + 1 >= this.regionsY) return CLS_NONE;
      const j = (row + 1) * w - 1;
      for (let i = col * w; i < Math.min(g.sizeX, (col + 1) * w); i++) {
        if (!view.passable(i, j) || !view.passable(i, j + 1)) continue;
        if (this.knownFree(i, j) && this.knownFree(i, j + 1)) return CLS_OPEN;
        cls = CLS_UNEXPLORED;
      }
    }
    return cls;
  }

  private knownFree(i: number, j: number): boolean {
    return !this.grid.isUnknown(i, j) && !this.grid.isBlocked(i, j);
  }

  private zonesOf(r: number): string[] {
    const g = this.grid;
    const col = r % this.regionsX;
    const row = (r / this.regionsX) | 0;
    const res = g.resolutionM;
    const x0 = col * this.regionCells * res;
    const y0 = row * this.regionCells * res;
    const x1 = Math.min(g.sizeX, (col + 1) * this.regionCells) * res;
    const y1 = Math.min(g.sizeY, (row + 1) * this.regionCells) * res;
    return g.zones.zones
      .filter((z) => polygonMeetsRect(z, x0, y0, x1, y1))
      .map((z) => z.id)
      .sort();
  }
}

/** The member cell nearest to the group's centroid (squared distance in integers × n), ties by index. */
function representative(members: readonly number[], sizeX: number): number {
  let sx = 0;
  let sy = 0;
  for (const c of members) {
    sx += c % sizeX;
    sy += (c / sizeX) | 0;
  }
  const n = members.length;
  let best = members[0] ?? 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of members) {
    const dx = (c % sizeX) * n - sx;
    const dy = ((c / sizeX) | 0) * n - sy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Whether a zone's polygon and a rectangle (open interiors) intersect. */
function polygonMeetsRect(z: Zone, x0: number, y0: number, x1: number, y1: number): boolean {
  const p = z.polygon;
  for (const [x, y] of p) if (x > x0 && x < x1 && y > y0 && y < y1) return true;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (pointInPolygon(cx, cy, p)) return true;
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) {
    if (pointInPolygon(x, y, p)) return true;
  }
  const rect: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let a = 0; a < p.length; a++) {
    const [ax = 0, ay = 0] = p[a] ?? [];
    const [bx = 0, by = 0] = p[(a + 1) % p.length] ?? [];
    for (let b = 0; b < 4; b++) {
      const [cx0, cy0] = rect[b] ?? [0, 0];
      const [cx1, cy1] = rect[(b + 1) % 4] ?? [0, 0];
      if (properCross(ax, ay, bx, by, cx0, cy0, cx1, cy1)) return true;
    }
  }
  return false;
}

function properCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
}
