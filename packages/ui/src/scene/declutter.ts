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

/** The screen box of a label that is shown (px; `x`, `y` its top left). */
export interface LabelBox {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** An agent that needs attention, or the selected one: its label is placed first and does not move. */
  readonly keep: boolean;
}

const GAP_PX = 2;
const overlaps = (a: LabelBox, b: LabelBox, dy: number) => a.x < b.x + b.w && b.x < a.x + a.w && a.y + dy < b.y + b.h && b.y < a.y + dy + a.h;

/**
 * Labels that would cover each other (an aerial agent above a ground one, two starting at the same base): each is moved down, by whole label heights, until it
 * touches none that is already placed; the labels that keep theirs are placed first. Returns the offset (px, down) of each box, in the order given. Pure, and the
 * same boxes give the same offsets.
 */
export function stackLabels(boxes: readonly LabelBox[]): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => Number(boxes[b]?.keep) - Number(boxes[a]?.keep) || (boxes[a]?.y ?? 0) - (boxes[b]?.y ?? 0) || (boxes[a]?.x ?? 0) - (boxes[b]?.x ?? 0) || (boxes[a]?.index ?? 0) - (boxes[b]?.index ?? 0));
  const offset = boxes.map(() => 0);
  const placed: { box: LabelBox; dy: number }[] = [];
  for (const i of order) {
    const b = boxes[i] as LabelBox;
    let dy = 0;
    // Each step clears at least one more box; the loop ends at the latest below the lowest of them.
    for (let guard = 0; guard < boxes.length + 1; guard++) {
      const hit = placed.find((p) => overlaps(b, { ...p.box, y: p.box.y + p.dy }, dy));
      if (!hit) break;
      dy = hit.box.y + hit.dy + hit.box.h + GAP_PX - b.y;
    }
    offset[i] = dy;
    placed.push({ box: b, dy });
  }
  return offset;
}
