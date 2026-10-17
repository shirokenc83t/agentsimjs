import { DIR_DX, DIR_DY, SQRT2, type SearchSpace } from "../grid/search-space.ts";

export interface ClusterBounds {
  readonly i0: number;
  readonly j0: number;
  readonly i1: number;
  readonly j1: number;
}

/** Shortest path from the source to one target inside a cluster: cost and the moves (direction codes). */
export interface ClusterPath {
  readonly cost: number;
  readonly dirs: Uint8Array;
}

/**
 * Dense Dijkstra inside one cluster for building the HPA* abstract graph (precomputation, no sim time):
 * typed scratch arrays sized to one cluster and reused across runs (generation stamps instead of clearing),
 * a preallocated two-key heap, and an early stop once every target is settled. Same moves, costs and tie
 * order as GridSearch (cost, then cell order — row-major inside the cluster is row-major on the map), so
 * results match a bounded GridSearch.
 */
export class ClusterDijkstra {
  private readonly dist: Float64Array;
  private readonly parentDir: Int8Array;
  private readonly stamp: Uint32Array;
  private readonly settled: Uint32Array;
  private readonly wanted: Uint32Array;
  // Lazy-deletion heap: each relaxation pushes once, so 8 entries per cell bound its size.
  private readonly heapKey: Float64Array;
  private readonly heapCell: Int32Array;
  private gen = 0;

  constructor(private readonly maxSide: number) {
    const n = maxSide * maxSide;
    this.dist = new Float64Array(n);
    this.parentDir = new Int8Array(n);
    this.stamp = new Uint32Array(n);
    this.settled = new Uint32Array(n);
    this.wanted = new Uint32Array(n);
    this.heapKey = new Float64Array(8 * n + 1);
    this.heapCell = new Int32Array(8 * n + 1);
  }

  /** Paths from `source` to each target (same order as `targets`); null where unreachable. */
  run(space: SearchSpace, b: ClusterBounds, source: number, targets: readonly number[]): (ClusterPath | null)[] {
    const sx = space.sizeX;
    const w = b.i1 - b.i0;
    const local = (cell: number) => (((cell / sx) | 0) - b.j0) * w + ((cell % sx) - b.i0);
    const gen = ++this.gen;
    const { dist, parentDir, stamp, settled, wanted, heapKey, heapCell } = this;
    const mask = space.mask;
    const base = space.basePerMetre;
    const perCode = space.codePerMetre;
    const unk = space.unknown;
    const uf = space.unknownFactor;
    const res = space.resolutionM;
    const general = space.hasEdgeConstraints;
    // Locals, not imported bindings, in the hot loop: module runners (Vitest) turn those into getter calls.
    const dxs = DIR_DX;
    const dys = DIR_DY;
    const sqrt2 = SQRT2;
    let remaining = 0;
    for (const t of targets) {
      const v = local(t);
      if (t !== source && wanted[v] !== gen) {
        wanted[v] = gen;
        remaining++;
      }
    }
    const s0 = local(source);
    stamp[s0] = gen;
    dist[s0] = 0;
    parentDir[s0] = -1;
    let size = 1;
    heapKey[0] = 0;
    heapCell[0] = s0;
    while (size > 0 && remaining > 0) {
      // pop (min by key, then cell)
      const u: number = heapCell[0] ?? 0;
      size--;
      if (size > 0) {
        const k = heapKey[size] ?? 0;
        const c = heapCell[size] ?? 0;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= size) break;
          const r = l + 1;
          let m = l;
          if (r < size) {
            const kl = heapKey[l] ?? 0;
            const kr = heapKey[r] ?? 0;
            if (kr < kl || (kr === kl && (heapCell[r] ?? 0) < (heapCell[l] ?? 0))) m = r;
          }
          const km = heapKey[m] ?? 0;
          if (km > k || (km === k && (heapCell[m] ?? 0) > c)) break;
          heapKey[i] = km;
          heapCell[i] = heapCell[m] ?? 0;
          i = m;
        }
        heapKey[i] = k;
        heapCell[i] = c;
      }
      if (settled[u] === gen) continue;
      settled[u] = gen;
      if (wanted[u] === gen) remaining--;
      const du = dist[u] ?? 0;
      const i: number = (u % w) + b.i0;
      const j: number = ((u / w) | 0) + b.j0;
      for (let dir = 0; dir < 8; dir++) {
        const ni: number = i + (dxs[dir] ?? 0);
        const nj: number = j + (dys[dir] ?? 0);
        if (ni < b.i0 || nj < b.j0 || ni >= b.i1 || nj >= b.j1) continue;
        const code = mask[nj * sx + ni] ?? 0;
        if (code === 0) continue;
        const diag = (dir & 1) === 1;
        if (diag && ((mask[j * sx + ni] ?? 0) === 0 || (mask[nj * sx + i] ?? 0) === 0)) continue;
        let perMetre = base + perCode * code;
        if (unk !== null && unk[nj * sx + ni] === 1) perMetre *= uf; // belief views: the unknown weight
        const c = general ? space.moveCost(i, j, dir, 0) : res * (diag ? sqrt2 : 1) * perMetre;
        if (c === Number.POSITIVE_INFINITY) continue;
        const v = (nj - b.j0) * w + (ni - b.i0);
        if (settled[v] === gen) continue;
        const nd = du + c;
        if (stamp[v] !== gen || nd < (dist[v] ?? Infinity)) {
          stamp[v] = gen;
          dist[v] = nd;
          parentDir[v] = dir;
          // push
          let p = size++;
          while (p > 0) {
            const q = (p - 1) >> 1;
            const kq = heapKey[q] ?? 0;
            if (kq < nd || (kq === nd && (heapCell[q] ?? 0) < v)) break;
            heapKey[p] = kq;
            heapCell[p] = heapCell[q] ?? 0;
            p = q;
          }
          heapKey[p] = nd;
          heapCell[p] = v;
        }
      }
    }
    return targets.map((t) => {
      if (t === source) return { cost: 0, dirs: new Uint8Array(0) };
      const v = local(t);
      if (settled[v] !== gen) return null;
      let n = 0;
      for (let cur = v; cur !== s0; n++) {
        const d = parentDir[cur] ?? -1;
        cur = ((cur / w) | 0) * w - (DIR_DY[d] ?? 0) * w + (cur % w) - (DIR_DX[d] ?? 0);
      }
      const dirs = new Uint8Array(n);
      for (let cur = v, k = n - 1; cur !== s0; k--) {
        const d = parentDir[cur] ?? -1;
        dirs[k] = d;
        cur = ((cur / w) | 0) * w - (DIR_DY[d] ?? 0) * w + (cur % w) - (DIR_DX[d] ?? 0);
      }
      return { cost: dist[v] ?? Infinity, dirs };
    });
  }

  get capacity(): number {
    return this.maxSide;
  }
}
