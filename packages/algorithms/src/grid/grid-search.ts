import { NodeTable, OpenHeap } from "./node-table.ts";
import { DIR_DX, DIR_DY, SQRT2, type SearchSpace } from "./search-space.ts";

/** Single-source algorithms available to agents (ADR-0028; HPA* lives in hpa/). */
export type GridAlgorithm = { readonly kind: "dijkstra" } | { readonly kind: "astar" } | { readonly kind: "weighted-astar"; readonly weight: number };

export type SearchStatus = "running" | "found" | "not_found" | "budget_exceeded";

export interface GridSearchOptions {
  /** Restrict the search to the cell rectangle [i0, i1) × [j0, j1) (HPA* cluster searches). */
  readonly bounds?: { readonly i0: number; readonly j0: number; readonly i1: number; readonly j1: number };
  /** Expand predecessors instead of successors: g = cost from a cell *to* the start (HPA* goal insertion). */
  readonly reverse?: boolean;
  /** Initial heading (0..7) for turn-aware profiles; absent = no turn cost on the first move. */
  readonly startDir?: number;
  /**
   * Exhaustive searches only (goal = -1): complete (status "found") as soon as every listed cell is settled,
   * instead of settling the whole region (HPA* start/goal insertion).
   */
  readonly settleTargets?: readonly number[];
  /**
   * Record the chunks the search reads (ADR-0024 addition of 2026-10-09, read-set rule): every chunk within two
   * cells of an expanded cell (its neighbours' passability and costs, and the ring that edge-constraint variables
   * such as slope read). A conservative superset: it can cause extra restarts, never a missed dependency.
   */
  readonly trackReads?: boolean;
  /**
   * Heuristic of A* and weighted A* (ADR-0037 addition of 2026-10-13): `octile` (default) or `euclidean`, both scaled by
   * the view's lower bound on cost per metre. Ignored by Dijkstra (weight 0).
   */
  readonly heuristic?: "octile" | "euclidean";
}

const TURN_RAD = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI] as const;

/**
 * Resumable best-first search on a SearchSpace (ADR-0024): `step(n)` performs at most n expansions and
 * can be called again; the expansion sequence is deterministic, so the state after E expansions is
 * reproducible. `goal` = -1 runs exhaustively (Dijkstra to every reachable cell, for HPA*).
 * Heuristic weight 0 = Dijkstra, 1 = A*, w > 1 = weighted A*.
 */
export class GridSearch {
  status: SearchStatus = "running";
  expanded = 0;
  cost = Number.POSITIVE_INFINITY;
  private readonly nodes = new NodeTable(8192);
  private readonly open = new OpenHeap();
  private readonly hWeight: number;
  private readonly turnAware: boolean;
  private readonly fast: boolean;
  private readonly euclid: boolean;
  private targets: Set<number> | undefined;
  private remainingTargets = 0;
  private goalState = -1;
  private readonly goalI: number;
  private readonly goalJ: number;
  private readonly sizeX: number;
  /** Chunks read (1 = read), when tracking; see `GridSearchOptions.trackReads`. */
  readonly readChunks: Uint8Array | undefined;
  private readonly chunkSize: number;
  private readonly chunksX: number;
  private readonly chunksY: number;

  constructor(
    private readonly space: SearchSpace,
    readonly startCell: number,
    readonly goalCell: number,
    algorithm: GridAlgorithm,
    readonly totalBudget: number,
    private readonly opts: GridSearchOptions = {},
  ) {
    this.sizeX = space.sizeX;
    this.chunkSize = space.grid.chunkSize;
    this.chunksX = space.grid.chunksX;
    this.chunksY = space.grid.chunksY;
    this.readChunks = opts.trackReads ? new Uint8Array(this.chunksX * this.chunksY) : undefined;
    this.hWeight = goalCell < 0 || algorithm.kind === "dijkstra" ? 0 : algorithm.kind === "astar" ? 1 : algorithm.weight;
    this.turnAware = space.profile.turnAware && !opts.bounds && !opts.reverse;
    this.fast = !this.turnAware && !opts.reverse && !space.hasEdgeConstraints;
    this.euclid = opts.heuristic === "euclidean";
    if (goalCell < 0 && opts.settleTargets) {
      this.targets = new Set(opts.settleTargets);
      this.remainingTargets = this.targets.size;
    }
    this.goalI = goalCell % this.sizeX;
    this.goalJ = (goalCell / this.sizeX) | 0;
    const si = startCell % this.sizeX;
    const sj = (startCell / this.sizeX) | 0;
    this.markRead(si, sj);
    if (!this.inBounds(si, sj) || !space.passable(si, sj)) {
      this.status = "not_found";
      return;
    }
    if (this.targets && this.remainingTargets === 0) {
      this.status = "found"; // nothing to settle
      return;
    }
    const startState = this.turnAware ? startCell * 9 + (opts.startDir === undefined ? 0 : opts.startDir + 1) : startCell;
    const slot = this.nodes.insert(startState);
    this.nodes.g[slot] = 0;
    const h = this.h(si, sj);
    this.open.push(this.hWeight * h, h, startState);
  }

  private inBounds(i: number, j: number): boolean {
    const b = this.opts.bounds;
    if (!b) return true;
    return i >= b.i0 && j >= b.j0 && i < b.i1 && j < b.j1;
  }

  private h(i: number, j: number): number {
    if (this.hWeight === 0) return 0;
    return this.euclid ? this.space.heuristicEuclidean(i, j, this.goalI, this.goalJ) : this.space.heuristic(i, j, this.goalI, this.goalJ);
  }

  private cellOf(state: number): number {
    return this.turnAware ? Math.floor(state / 9) : state;
  }

  /** Performs up to `maxExpansions` expansions; returns the status. */
  step(maxExpansions: number): SearchStatus {
    if (this.status !== "running") return this.status;
    const space = this.space;
    const reverse = this.opts.reverse === true;
    let budget = maxExpansions;
    while (budget > 0) {
      if (this.open.size === 0) {
        this.status = "not_found";
        return this.status;
      }
      const state = this.open.pop();
      const slot = this.nodes.find(state);
      if (slot < 0 || this.nodes.closed[slot] === 1) continue; // stale heap entry
      if (this.expanded >= this.totalBudget) {
        this.status = "budget_exceeded";
        return this.status;
      }
      this.nodes.closed[slot] = 1;
      this.expanded++;
      budget--;
      const cell = this.cellOf(state);
      if (this.targets?.has(cell) && --this.remainingTargets === 0) {
        this.status = "found"; // every requested cell is settled
        return this.status;
      }
      if (cell === this.goalCell) {
        this.goalState = state;
        this.cost = this.nodes.g[slot] ?? Number.POSITIVE_INFINITY;
        this.status = "found";
        return this.status;
      }
      const g = this.nodes.g[slot] ?? 0;
      const i = cell % this.sizeX;
      const j = (cell / this.sizeX) | 0;
      if (this.readChunks) this.markRead(i, j);
      if (this.fast) {
        // The octile routine is the hot path and is not edited for the euclidean option: that one is a separate copy.
        if (this.euclid) this.expandFastEuclid(state, i, j, g);
        else this.expandFast(state, i, j, g);
        continue;
      }
      const inDir = this.turnAware ? (state % 9) - 1 : -1;
      const dxs = DIR_DX;
      const dys = DIR_DY;
      for (let dir = 0; dir < 8; dir++) {
        const ni = i + (dxs[dir] ?? 0);
        const nj = j + (dys[dir] ?? 0);
        if (!this.inBounds(ni, nj)) continue;
        let c: number;
        if (reverse) {
          // predecessor (ni, nj) moving into (i, j) in direction (dir + 4) % 8
          const back = (dir + 4) & 7;
          if (!space.canMove(ni, nj, back)) continue;
          c = space.moveCost(ni, nj, back, 0);
        } else {
          if (!space.canMove(i, j, dir)) continue;
          let turn = 0;
          if (inDir >= 0) {
            const d = Math.abs(dir - inDir);
            turn = TURN_RAD[Math.min(d, 8 - d)] ?? 0;
          }
          c = space.moveCost(i, j, dir, turn);
        }
        if (c === Number.POSITIVE_INFINITY) continue;
        const ncell = nj * this.sizeX + ni;
        const nstate = this.turnAware ? ncell * 9 + dir + 1 : ncell;
        let ns = this.nodes.find(nstate);
        if (ns < 0) ns = this.nodes.insert(nstate);
        else if (this.nodes.closed[ns] === 1) continue;
        const ng = g + c;
        if (ng < (this.nodes.g[ns] ?? Number.POSITIVE_INFINITY)) {
          this.nodes.g[ns] = ng;
          this.nodes.parent[ns] = state;
          const h = this.h(ni, nj);
          this.open.push(ng + this.hWeight * h, h, nstate);
        }
      }
    }
    return this.status;
  }

  /**
   * Hot path for forward, non-turn-aware searches without edge constraints (the common case): passability
   * and cost code come from the mask byte, corners are checked by index, the heuristic is inlined.
   * Costs use exactly SearchSpace.moveCost's expression, so results equal the general path bit for bit.
   */
  private expandFast(state: number, i: number, j: number, g: number): void {
    const space = this.space;
    const mask = space.mask;
    const sx = this.sizeX;
    const b = this.opts.bounds;
    const i0 = b ? b.i0 : 0;
    const j0 = b ? b.j0 : 0;
    const i1 = b ? b.i1 : sx;
    const j1 = b ? b.j1 : space.sizeY;
    const base = space.basePerMetre;
    const perCode = space.codePerMetre;
    const unk = space.unknown;
    const uf = space.unknownFactor;
    const hw = this.hWeight;
    const hpc = space.heuristicPerCell;
    const res = space.resolutionM;
    // Locals, not imported bindings, in the hot loop: module runners (Vitest) turn those into getter calls.
    const dxs = DIR_DX;
    const dys = DIR_DY;
    const sqrt2 = SQRT2;
    for (let dir = 0; dir < 8; dir++) {
      const dx = dxs[dir] ?? 0;
      const dy = dys[dir] ?? 0;
      const ni = i + dx;
      const nj = j + dy;
      if (ni < i0 || nj < j0 || ni >= i1 || nj >= j1) continue;
      const ncell = nj * sx + ni;
      const code = mask[ncell] ?? 0;
      if (code === 0) continue;
      const diag = (dir & 1) === 1;
      if (diag && ((mask[j * sx + ni] ?? 0) === 0 || (mask[nj * sx + i] ?? 0) === 0)) continue; // no corner cutting
      const len = res * (diag ? sqrt2 : 1);
      let perMetre = base + perCode * code;
      if (unk !== null && unk[ncell] === 1) perMetre *= uf; // belief views: the cost profile's unknown weight
      const c = len * perMetre; // moveCost with turnRad = 0
      const ns = this.nodes.findOrInsert(ncell);
      if (this.nodes.closed[ns] === 1) continue;
      const ng = g + c;
      if (ng < (this.nodes.g[ns] ?? Number.POSITIVE_INFINITY)) {
        this.nodes.g[ns] = ng;
        this.nodes.parent[ns] = state;
        let h = 0;
        if (hw !== 0) {
          const ax = ni > this.goalI ? ni - this.goalI : this.goalI - ni;
          const ay = nj > this.goalJ ? nj - this.goalJ : this.goalJ - nj;
          const lo = ax < ay ? ax : ay;
          h = ((ax > ay ? ax : ay) - lo + sqrt2 * lo) * hpc;
        }
        this.open.push(ng + hw * h, h, ncell);
      }
    }
  }

  /**
   * `expandFast` with the euclidean heuristic (ADR-0037 addition of 2026-10-13). A deliberate copy, not a parameter: the
   * octile routine above is the benchmarked hot path (`planning.slice20k`) and stays byte for byte as it was. Only the
   * `h` expression differs; `heuristic.property.test.ts` runs both against an independent Dijkstra.
   */
  private expandFastEuclid(state: number, i: number, j: number, g: number): void {
    const space = this.space;
    const mask = space.mask;
    const sx = this.sizeX;
    const b = this.opts.bounds;
    const i0 = b ? b.i0 : 0;
    const j0 = b ? b.j0 : 0;
    const i1 = b ? b.i1 : sx;
    const j1 = b ? b.j1 : space.sizeY;
    const base = space.basePerMetre;
    const perCode = space.codePerMetre;
    const unk = space.unknown;
    const uf = space.unknownFactor;
    const hw = this.hWeight;
    const hpc = space.heuristicPerCell;
    const res = space.resolutionM;
    const dxs = DIR_DX;
    const dys = DIR_DY;
    const sqrt2 = SQRT2;
    for (let dir = 0; dir < 8; dir++) {
      const dx = dxs[dir] ?? 0;
      const dy = dys[dir] ?? 0;
      const ni = i + dx;
      const nj = j + dy;
      if (ni < i0 || nj < j0 || ni >= i1 || nj >= j1) continue;
      const ncell = nj * sx + ni;
      const code = mask[ncell] ?? 0;
      if (code === 0) continue;
      const diag = (dir & 1) === 1;
      if (diag && ((mask[j * sx + ni] ?? 0) === 0 || (mask[nj * sx + i] ?? 0) === 0)) continue; // no corner cutting
      const len = res * (diag ? sqrt2 : 1);
      let perMetre = base + perCode * code;
      if (unk !== null && unk[ncell] === 1) perMetre *= uf;
      const c = len * perMetre;
      const ns = this.nodes.findOrInsert(ncell);
      if (this.nodes.closed[ns] === 1) continue;
      const ng = g + c;
      if (ng < (this.nodes.g[ns] ?? Number.POSITIVE_INFINITY)) {
        this.nodes.g[ns] = ng;
        this.nodes.parent[ns] = state;
        let h = 0;
        if (hw !== 0) {
          const ax = ni - this.goalI;
          const ay = nj - this.goalJ;
          h = Math.sqrt(ax * ax + ay * ay) * hpc;
        }
        this.open.push(ng + hw * h, h, ncell);
      }
    }
  }

  /** Marks the chunks within two cells of (i, j) as read. */
  private markRead(i: number, j: number): void {
    const r = this.readChunks;
    if (!r) return;
    const cs = this.chunkSize;
    const ci0 = Math.max(0, ((i - 2) / cs) | 0);
    const cj0 = Math.max(0, ((j - 2) / cs) | 0);
    const ci1 = Math.min(this.chunksX - 1, ((i + 2) / cs) | 0);
    const cj1 = Math.min(this.chunksY - 1, ((j + 2) / cs) | 0);
    for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) r[cj * this.chunksX + ci] = 1;
  }

  /** Whether the search has read any of these chunks (false without tracking). */
  hasRead(chunks: readonly number[]): boolean {
    const r = this.readChunks;
    if (!r) return false;
    for (const k of chunks) if (r[k] === 1) return true;
    return false;
  }

  /** Runs to completion (precomputation only — query paths must use `step` with budgets). */
  runToCompletion(): SearchStatus {
    while (this.status === "running") this.step(1 << 20);
    return this.status;
  }

  /** Cells of the found path, start first (cell indices). */
  path(): number[] {
    if (this.status !== "found") return [];
    const out: number[] = [];
    let s = this.goalState;
    while (s >= 0) {
      out.push(this.cellOf(s));
      const slot = this.nodes.find(s);
      s = slot < 0 ? -1 : (this.nodes.parent[slot] ?? -1);
    }
    return out.reverse();
  }

  /** Settled cost of `cell` (exhaustive or partial searches), or +Infinity. Non-turn-aware searches only. */
  costTo(cell: number): number {
    const slot = this.nodes.find(cell);
    return slot >= 0 && this.nodes.closed[slot] === 1 ? (this.nodes.g[slot] ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  }

  /** Path from the start to a settled `cell` (exhaustive searches). */
  pathTo(cell: number): number[] {
    const out: number[] = [];
    let s = this.nodes.find(cell) >= 0 ? cell : -1;
    while (s >= 0) {
      out.push(this.cellOf(s));
      const slot = this.nodes.find(s);
      s = slot < 0 ? -1 : (this.nodes.parent[slot] ?? -1);
    }
    return out.reverse();
  }
}
