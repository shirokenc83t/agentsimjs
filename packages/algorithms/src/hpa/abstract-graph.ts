import { DIR_DX, DIR_DY, type SearchSpace } from "../grid/search-space.ts";
import { ClusterDijkstra } from "./cluster-dijkstra.ts";

/** Directed abstract edge (costs differ per direction: terrain is charged on the destination cell). */
export interface AbstractEdge {
  readonly to: number;
  readonly cost: number;
  /** Intra-cluster edges: the precomputed moves (direction codes) from the source to `to`. */
  readonly path?: Uint8Array;
}

/** Long border segments get two transitions (at both ends), short ones a single one in the middle. */
const LONG_SEGMENT = 6;

/**
 * HPA* abstract graph (ADR-0012, ADR-0024) over a SearchSpace: clusters are the grid chunks, abstract nodes
 * are border transition cells, edges are inter-cluster steps and intra-cluster shortest paths. Built
 * without sim-time cost (precomputed structure); `sync()` rebuilds only the clusters around changed chunks.
 * Node and edge order is deterministic (sorted by cell index). Live, like its view (ADR-0024 addition of
 * 2026-10-10): synced in place at the run's sync points; queries in progress restart when it changes.
 */
export class AbstractGraph {
  readonly clustersX: number;
  readonly clustersY: number;
  readonly clusterSize: number;
  /** Border key -> transition pairs [cellA, cellB] (A on the left/bottom side). */
  private readonly borders = new Map<string, [number, number][]>();
  /** Cluster index -> sorted abstract node cells. */
  private readonly clusterNodes: number[][] = [];
  /** Cluster index -> (node cell -> intra edges sorted by target). */
  private readonly intra: Map<number, AbstractEdge[]>[] = [];
  /** The view's content version this graph reflects. */
  private seen: number;
  /** Bumped whenever a sync rebuilt clusters: an HPA* query in progress restarts when it moved. */
  private graphVersion = 0;

  /** Builds the graph over `space` (brought up to date with its map first). */
  constructor(readonly space: SearchSpace) {
    const g = space.grid;
    this.clusterSize = g.chunkSize;
    this.clustersX = g.chunksX;
    this.clustersY = g.chunksY;
    for (let k = 0; k < this.clustersX * this.clustersY; k++) {
      this.clusterNodes.push([]);
      this.intra.push(new Map());
    }
    space.sync();
    this.seen = space.contentVersion;
    this.rebuildBlock(0, 0, this.clustersX - 1, this.clustersY - 1);
  }

  get version(): number {
    return this.graphVersion;
  }

  /**
   * Brings the graph up to date with its view (syncing the view first), in place: rebuilds the clusters around
   * chunks whose view content changed since the graph last looked. Returns the clusters rebuilt.
   */
  sync(): number[] {
    this.space.sync();
    const changed = this.space.changedSince(this.seen);
    this.seen = this.space.contentVersion;
    if (changed.length === 0) return [];
    this.graphVersion++;
    const rebuilt = new Set<number>();
    for (const k of changed) {
      const ci = k % this.clustersX;
      const cj = (k / this.clustersX) | 0;
      // The mask refresh touches a one-cell ring around the chunk: rebuild the 3×3 cluster block.
      for (const c of this.rebuildBlock(ci - 1, cj - 1, ci + 1, cj + 1)) rebuilt.add(c);
    }
    return [...rebuilt].sort((a, b) => a - b);
  }

  clusterOfCell(cell: number): number {
    const i = cell % this.space.sizeX;
    const j = (cell / this.space.sizeX) | 0;
    return ((j / this.clusterSize) | 0) * this.clustersX + ((i / this.clusterSize) | 0);
  }

  clusterBounds(cluster: number): { i0: number; j0: number; i1: number; j1: number } {
    const ci = cluster % this.clustersX;
    const cj = (cluster / this.clustersX) | 0;
    const cs = this.clusterSize;
    return { i0: ci * cs, j0: cj * cs, i1: Math.min(this.space.sizeX, (ci + 1) * cs), j1: Math.min(this.space.sizeY, (cj + 1) * cs) };
  }

  nodesOf(cluster: number): readonly number[] {
    return this.clusterNodes[cluster] ?? [];
  }

  /** Outgoing abstract edges of `cell`: intra-cluster, then inter-cluster (both sorted by target). */
  edgesFrom(cell: number): AbstractEdge[] {
    const cluster = this.clusterOfCell(cell);
    const out = [...(this.intra[cluster]?.get(cell) ?? [])];
    const inter: AbstractEdge[] = [];
    const ci = cluster % this.clustersX;
    const cj = (cluster / this.clustersX) | 0;
    for (const key of [`v:${ci - 1},${cj}`, `v:${ci},${cj}`, `h:${ci},${cj - 1}`, `h:${ci},${cj}`]) {
      for (const [a, b] of this.borders.get(key) ?? []) {
        if (a === cell) inter.push({ to: b, cost: this.stepCost(a, b) });
        else if (b === cell) inter.push({ to: a, cost: this.stepCost(b, a) });
      }
    }
    inter.sort((x, y) => x.to - y.to);
    return out.concat(inter);
  }

  /** Cost of one orthogonal step between adjacent cells a -> b. */
  stepCost(a: number, b: number): number {
    const sx = this.space.sizeX;
    const di = (b % sx) - (a % sx);
    const dj = ((b / sx) | 0) - ((a / sx) | 0);
    const dir = di === 1 ? 0 : dj === 1 ? 2 : di === -1 ? 4 : 6;
    return this.space.moveCost(a % sx, (a / sx) | 0, dir, 0);
  }

  /** Recomputes borders and intra edges for clusters in [ci0..ci1] × [cj0..cj1] (clamped); returns them. */
  private rebuildBlock(ci0: number, cj0: number, ci1: number, cj1: number): number[] {
    const a0 = Math.max(0, ci0);
    const b0 = Math.max(0, cj0);
    const a1 = Math.min(this.clustersX - 1, ci1);
    const b1 = Math.min(this.clustersY - 1, cj1);
    // Borders of every cluster in the block (including its outer borders).
    for (let cj = b0; cj <= b1; cj++) {
      for (let ci = a0; ci <= a1; ci++) {
        if (ci + 1 < this.clustersX) this.borders.set(`v:${ci},${cj}`, this.scanBorder(ci, cj, true));
        if (ci - 1 >= 0) this.borders.set(`v:${ci - 1},${cj}`, this.scanBorder(ci - 1, cj, true));
        if (cj + 1 < this.clustersY) this.borders.set(`h:${ci},${cj}`, this.scanBorder(ci, cj, false));
        if (cj - 1 >= 0) this.borders.set(`h:${ci},${cj - 1}`, this.scanBorder(ci, cj - 1, false));
      }
    }
    const rebuilt: number[] = [];
    for (let cj = b0; cj <= b1; cj++) {
      for (let ci = a0; ci <= a1; ci++) {
        const k = cj * this.clustersX + ci;
        this.rebuildCluster(k);
        rebuilt.push(k);
      }
    }
    return rebuilt;
  }

  /** Transitions across the border between cluster (ci, cj) and its right (vertical) or top neighbour. */
  private scanBorder(ci: number, cj: number, vertical: boolean): [number, number][] {
    const s = this.space;
    const cs = this.clusterSize;
    const out: [number, number][] = [];
    const len = vertical ? Math.min(cs, s.sizeY - cj * cs) : Math.min(cs, s.sizeX - ci * cs);
    const cellA = (t: number) => (vertical ? (cj * cs + t) * s.sizeX + (ci + 1) * cs - 1 : ((cj + 1) * cs - 1) * s.sizeX + ci * cs + t);
    const delta = vertical ? 1 : s.sizeX;
    let start = -1;
    const flush = (end: number) => {
      if (start < 0) return;
      const n = end - start;
      const picks = n < LONG_SEGMENT ? [start + ((n - 1) >> 1)] : [start, end - 1];
      for (const t of picks) out.push([cellA(t), cellA(t) + delta]);
      start = -1;
    };
    for (let t = 0; t < len; t++) {
      const a = cellA(t);
      const ok = s.mask[a] !== 0 && s.mask[a + delta] !== 0;
      if (ok && start < 0) start = t;
      if (!ok) flush(t);
    }
    flush(len);
    return out;
  }

  private rebuildCluster(k: number): void {
    const ci = k % this.clustersX;
    const cj = (k / this.clustersX) | 0;
    const cells = new Set<number>();
    for (const key of [`v:${ci - 1},${cj}`, `v:${ci},${cj}`, `h:${ci},${cj - 1}`, `h:${ci},${cj}`]) {
      for (const [a, b] of this.borders.get(key) ?? []) {
        if (this.clusterOfCell(a) === k) cells.add(a);
        if (this.clusterOfCell(b) === k) cells.add(b);
      }
    }
    const nodes = [...cells].sort((x, y) => x - y);
    this.clusterNodes[k] = nodes;
    const edges = new Map<number, AbstractEdge[]>();
    const bounds = this.clusterBounds(k);
    const dijkstra = this.scratch();
    for (const u of nodes) {
      const paths = dijkstra.run(this.space, bounds, u, nodes);
      const list: AbstractEdge[] = [];
      nodes.forEach((v, idx) => {
        const p = paths[idx];
        if (v !== u && p) list.push({ to: v, cost: p.cost, path: p.dirs });
      });
      edges.set(u, list);
    }
    this.intra[k] = edges;
  }

  private dijkstraScratch: ClusterDijkstra | undefined;

  /** Shared scratch arrays for cluster searches (sized to one cluster). */
  private scratch(): ClusterDijkstra {
    this.dijkstraScratch ??= new ClusterDijkstra(this.clusterSize);
    return this.dijkstraScratch;
  }

  /** Cells of the precomputed intra-cluster path a -> b (a first), or undefined if there is no such edge. */
  intraPath(a: number, b: number): number[] | undefined {
    const e = this.intra[this.clusterOfCell(a)]?.get(a)?.find((x) => x.to === b);
    if (!e?.path) return undefined;
    const sx = this.space.sizeX;
    const out = [a];
    let cell = a;
    for (const d of e.path) {
      cell += (DIR_DY[d] ?? 0) * sx + (DIR_DX[d] ?? 0);
      out.push(cell);
    }
    return out;
  }

  /** Canonical description for equality tests (local rebuild vs full rebuild). */
  canonical(): string {
    const parts: string[] = [];
    for (let k = 0; k < this.clusterNodes.length; k++) {
      for (const u of this.clusterNodes[k] ?? []) {
        parts.push(`${u}:${this.edgesFrom(u).map((e) => `${e.to}@${e.cost}`).join(",")}`);
      }
    }
    return parts.join("\n");
  }

  get nodeCount(): number {
    return this.clusterNodes.reduce((a, n) => a + n.length, 0);
  }
}
