/**
 * Declutter of the map's labels (UI-SPEC §4): agents whose markers are too close on the screen to tell apart collapse into one chip with a count, except the agents
 * that need attention, which always keep their own label. Pure, so the renderer and its test agree.
 */
export interface ScreenPoint {
  /** The agent's index in the run. */
  readonly index: number;
  /** Position on the screen (px). */
  readonly x: number;
  readonly y: number;
  /** An agent that keeps its label whatever is near (it has an attention condition, or it is selected). */
  readonly keep: boolean;
}

export interface ScreenCluster {
  /** Agent indices, in order. */
  readonly members: readonly number[];
  /** Centroid on the screen (px). */
  readonly cx: number;
  readonly cy: number;
}

/**
 * Groups of two or more agents (not kept) each within `radiusPx` of another of the group (a chain counts). Deterministic: the same points give the same clusters in
 * the same order.
 */
export function clusterPoints(points: readonly ScreenPoint[], radiusPx: number): ScreenCluster[] {
  const free = points.filter((p) => !p.keep);
  const parent = free.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[i] !== r) {
      const next = parent[i] as number;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  // A grid of cells as wide as the radius: only the cell and its eight neighbours can hold a neighbour.
  const cell = (v: number) => Math.floor(v / radiusPx);
  const grid = new Map<string, number[]>();
  free.forEach((p, i) => {
    const key = `${cell(p.x)},${cell(p.y)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  const r2 = radiusPx * radiusPx;
  free.forEach((p, i) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cell(p.x) + dx},${cell(p.y) + dy}`) ?? []) {
          if (j <= i) continue;
          const q = free[j] as ScreenPoint;
          if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2) parent[find(j)] = find(i);
        }
      }
    }
  });
  const groups = new Map<number, number[]>();
  free.forEach((_, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  });
  const out: ScreenCluster[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const members = g.map((i) => (free[i] as ScreenPoint).index).sort((a, b) => a - b);
    const cx = g.reduce((s, i) => s + (free[i] as ScreenPoint).x, 0) / g.length;
    const cy = g.reduce((s, i) => s + (free[i] as ScreenPoint).y, 0) / g.length;
    out.push({ members, cx, cy });
  }
  return out.sort((a, b) => (a.members[0] as number) - (b.members[0] as number));
}
