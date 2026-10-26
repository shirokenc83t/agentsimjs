import type { Mark } from "./marks.ts";

/** The pseudo-lane that stands for the agents with no marks, folded into one row. */
export const FOLD_LANE = "…fold";

/** From this many agents without marks the lanes fold into one row (one empty lane is left as it is). */
export const FOLD_FROM = 2;

export interface FoldedLanes {
  readonly lanes: readonly string[];
  /** The agents whose lanes are folded (or that the fold row would fold), in the run's order. */
  readonly empty: readonly string[];
}

/**
 * The lanes of a timeline: the run's own, then one a agent; the agents with no marks at all take one row ("17 agents with no marks ▸") that opens them, so empty lanes do not
 * take the room of the ones that say something. Opened, every lane is shown and the row at the end folds them again.
 */
export function foldLanes(all: readonly string[], marks: readonly Pick<Mark, "agentId">[], open: boolean): FoldedLanes {
  const marked = new Set(marks.map((m) => m.agentId));
  const empty = all.filter((l, i) => i > 0 && !marked.has(l));
  if (empty.length < FOLD_FROM) return { lanes: all, empty: [] };
  if (open) return { lanes: [...all, FOLD_LANE], empty };
  return { lanes: [...all.filter((l, i) => i === 0 || marked.has(l)), FOLD_LANE], empty };
}

/** What the fold row says. */
export const foldLabel = (empty: number, open: boolean): string => (open ? `${empty} agents with no marks ▾ fold them` : `${empty} agents with no marks ▸`);
