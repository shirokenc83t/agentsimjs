/**
 * Hierarchical occupancy pyramid (ADR-0012), mipmap-like. Level k (k ≥ 1) has one entry per 2^k × 2^k
 * block of cells, with two flags:
 * - ANY_BLOCKED: at least one cell in the block is blocked;
 * - ALL_BLOCKED: every cell in the block is blocked.
 * Long-range queries ("is this region entirely free / entirely blocked?") and hierarchical heuristics
 * read coarse levels instead of scanning cells. Levels are rebuilt incrementally per dirty chunk.
 */
export const ANY_BLOCKED = 1;
export const ALL_BLOCKED = 2;

export class OccupancyPyramid {
  /** levels[k-1] is level k; sizes rounded up, padding cells count as free. */
  readonly levels: Uint8Array[] = [];
  readonly widths: number[] = [];
  readonly heights: number[] = [];

  constructor(
    private readonly sizeX: number,
    private readonly sizeY: number,
    private readonly blocked: (i: number, j: number) => boolean,
    /** Coarsest level; 6 = 64×64 cells per entry (one chunk). */
    readonly maxLevel = 6,
  ) {
    let w = sizeX;
    let h = sizeY;
    for (let k = 1; k <= maxLevel; k++) {
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
      this.widths.push(w);
      this.heights.push(h);
      this.levels.push(new Uint8Array(w * h));
    }
    this.rebuildRegion(0, 0, sizeX, sizeY);
  }

  /** Flags of the level-`k` entry containing block (bi, bj). Level 0 is the cell itself. */
  flags(k: number, bi: number, bj: number): number {
    if (k === 0) return this.blocked(bi, bj) ? ANY_BLOCKED | ALL_BLOCKED : 0;
    const w = this.widths[k - 1] ?? 0;
    return this.levels[k - 1]?.[bj * w + bi] ?? 0;
  }

  /** Recomputes all levels over the cell rectangle [i0, i1) × [j0, j1) (e.g. one dirty chunk). */
  rebuildRegion(i0: number, j0: number, i1: number, j1: number): void {
    let a0 = i0;
    let b0 = j0;
    let a1 = i1;
    let b1 = j1;
    for (let k = 1; k <= this.maxLevel; k++) {
      a0 >>= 1;
      b0 >>= 1;
      a1 = (a1 + 1) >> 1;
      b1 = (b1 + 1) >> 1;
      const w = this.widths[k - 1] ?? 0;
      const lvl = this.levels[k - 1];
      if (!lvl) return;
      for (let bj = b0; bj < b1; bj++) {
        for (let bi = a0; bi < a1; bi++) {
          let any = false;
          let all = true;
          for (let dj = 0; dj < 2; dj++) {
            for (let di = 0; di < 2; di++) {
              const ci = bi * 2 + di;
              const cj = bj * 2 + dj;
              const childW = k === 1 ? this.sizeX : (this.widths[k - 2] ?? 0);
              const childH = k === 1 ? this.sizeY : (this.heights[k - 2] ?? 0);
              if (ci >= childW || cj >= childH) {
                all = false; // padding is free
                continue;
              }
              const f = this.flags(k - 1, ci, cj);
              if (f & ANY_BLOCKED) any = true;
              if (!(f & ALL_BLOCKED)) all = false;
            }
          }
          lvl[bj * w + bi] = (any ? ANY_BLOCKED : 0) | (all ? ALL_BLOCKED : 0);
        }
      }
    }
  }

  /**
   * True if any cell in [i0, i1) × [j0, j1) is blocked. Descends from the coarsest level: blocks with no
   * blocked cell are skipped whole, fully blocked blocks answer immediately, only mixed blocks recurse.
   */
  anyBlockedIn(i0: number, j0: number, i1: number, j1: number): boolean {
    const a0 = Math.max(0, i0);
    const b0 = Math.max(0, j0);
    const a1 = Math.min(this.sizeX, i1);
    const b1 = Math.min(this.sizeY, j1);
    if (a0 >= a1 || b0 >= b1) return false;
    const k = this.maxLevel;
    const size = 1 << k;
    for (let bj = b0 >> k; bj <= (b1 - 1) >> k; bj++) {
      for (let bi = a0 >> k; bi <= (a1 - 1) >> k; bi++) {
        if (this.anyInBlock(k, bi, bj, a0, b0, a1, b1, size)) return true;
      }
    }
    return false;
  }

  private anyInBlock(k: number, bi: number, bj: number, a0: number, b0: number, a1: number, b1: number, size: number): boolean {
    const f = this.flags(k, bi, bj);
    if (!(f & ANY_BLOCKED)) return false;
    const x0 = bi * size;
    const y0 = bj * size;
    const inside = x0 >= a0 && y0 >= b0 && x0 + size <= a1 && y0 + size <= b1;
    if (inside || k === 0) return true; // fully covered block with a blocked cell, or a blocked cell
    if (f & ALL_BLOCKED) return true; // every cell blocked, and the block intersects the rectangle
    const half = size >> 1;
    for (let dj = 0; dj < 2; dj++) {
      for (let di = 0; di < 2; di++) {
        const ci = bi * 2 + di;
        const cj = bj * 2 + dj;
        const cx = ci * half;
        const cy = cj * half;
        if (cx >= a1 || cy >= b1 || cx + half <= a0 || cy + half <= b0) continue; // no overlap
        if (this.anyInBlock(k - 1, ci, cj, a0, b0, a1, b1, half)) return true;
      }
    }
    return false;
  }
}
