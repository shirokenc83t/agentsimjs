// The union of what the swarm knows (ADR-0043 section 7, T-101): a cell is known to the swarm when at least one agent's belief map has a state for it (free or occupied, not unknown), taken from
// the belief maps that replay rebuilds from the recorded keyframes and deltas (`replay.beliefAt`). Observer data: nothing of it reaches a mind. Pure; the reads are the hook's.

/** An agent's belief map at a tick as replay returns it: the chunks of the groups read, one byte per cell (0 unknown, 1 free, 2 occupied), `chunkSize²` bytes per chunk, row by row. */
export interface BeliefMapBytes {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly chunkSize: number;
  /** `(ci, cj)` of each chunk in `data`. */
  readonly coords: ArrayLike<number>;
  readonly data: ArrayLike<number>;
}

export interface UnionKnown {
  /** Cells known to at least one agent. */
  readonly known: number;
  /** Cells of the map. */
  readonly total: number;
  /** `known` as a percentage of `total`, two decimals. */
  readonly pct: number;
}

/** The cells known by at least one of `maps`, over the map they are all maps of. */
export function unionKnown(maps: readonly BeliefMapBytes[]): UnionKnown {
  const first = maps[0];
  if (first === undefined) return { known: 0, total: 0, pct: 0 };
  const { sizeX, sizeY } = first;
  const flags = new Uint8Array(sizeX * sizeY);
  let known = 0;
  for (const m of maps) {
    if (m.sizeX !== sizeX || m.sizeY !== sizeY) throw new RangeError("the belief maps are not maps of one world");
    const cs = m.chunkSize;
    const cells = cs * cs;
    const chunks = Math.floor(m.coords.length / 2);
    for (let k = 0; k < chunks; k++) {
      const ci = m.coords[2 * k] as number;
      const cj = m.coords[2 * k + 1] as number;
      const base = k * cells;
      for (let lj = 0; lj < cs; lj++) {
        const j = cj * cs + lj;
        if (j >= sizeY) break;
        for (let li = 0; li < cs; li++) {
          const i = ci * cs + li;
          if (i >= sizeX) break;
          if ((m.data[base + lj * cs + li] as number) !== 0 && flags[j * sizeX + i] === 0) {
            flags[j * sizeX + i] = 1;
            known++;
          }
        }
      }
    }
  }
  const total = sizeX * sizeY;
  return { known, total, pct: Math.round((10000 * known) / total) / 100 };
}
