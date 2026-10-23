import type { PaneView } from "./panes.ts";

/** The smallest a pane of each view may be (px): a log keeps time, agent, tag and summary, a table its columns, a series its axes and a line. A pane never shrinks below it. */
export const MIN_PANE: Readonly<Record<PaneView, { readonly w: number; readonly h: number }>> = {
  log: { w: 420, h: 200 },
  table: { w: 360, h: 200 },
  series: { w: 300, h: 160 },
};

/** How the panes are laid out in the area: a grid (a pane may span columns), or, when they do not fit at their minimum sizes, as tabs of which one is shown. */
export type GridPlan =
  | { readonly mode: "grid"; readonly cols: number; readonly rows: number; readonly spans: readonly number[] }
  | { readonly mode: "tabs" };

/** The grids to try for `n` panes, nicest first: 1 full, 2 side by side, 3 and 4 as 2 × 2 (a third spans the row below), then the same one above the other. */
function candidates(n: number): { cols: number; rows: number; spans: number[] }[] {
  if (n <= 1) return [{ cols: 1, rows: 1, spans: [1] }];
  const spans = (cols: number) => Array.from({ length: n }, (_, i) => (n % cols === 1 && i === n - 1 ? cols : 1));
  const two = n === 2 ? [{ cols: 2, rows: 1, spans: [1, 1] }] : [{ cols: 2, rows: Math.ceil(n / 2), spans: spans(2) }];
  return [...two, { cols: 1, rows: n, spans: Array.from({ length: n }, () => 1) }];
}

/**
 * The layout of `views` in an area of `width` × `height` px: the first grid in which every pane has at least its minimum size, else tabs (panes stack as tabs rather than
 * shrink, and never overlap). Pure.
 */
export function planGrid(views: readonly PaneView[], width: number, height: number): GridPlan {
  const n = views.length;
  for (const c of candidates(n)) {
    const cellH = height / c.rows;
    const fits = views.every((v, i) => {
      const cellW = (width / c.cols) * (c.spans[i] ?? 1);
      const min = MIN_PANE[v];
      return cellW >= min.w && cellH >= min.h;
    });
    if (fits) return { mode: "grid", cols: c.cols, rows: c.rows, spans: c.spans };
  }
  return { mode: "tabs" };
}
