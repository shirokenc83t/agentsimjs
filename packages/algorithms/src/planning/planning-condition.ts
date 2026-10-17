import type { ExprContext } from "@agentsim/core";
import type { PlanningGrid } from "@agentsim/spatial";
import { FEATURES } from "../cost-profile.ts";

/**
 * The `planning-condition` expression context (ADR-0037 §2, ADR-0026): the only names a `select` condition may use,
 * and exactly what the agent's planner legitimately knows when a query starts. No ground truth the agent could not
 * know, no other agent's state, no wall time. A name outside this table fails with the grammar's `expr_unknown_name`.
 *
 * - `dist.m`: straight-line distance from start to goal (m);
 * - `vehicle`, `altitude`: the agent's kind and altitude at query start (0 for ground vehicles), as in the cost context;
 * - `profile.<feature>`: true if the active cost profile gives that ADR-0014 feature a non-zero weight;
 * - `budget.total`: the query's total expansion budget;
 * - `replan.count`: how many times this query restarted because its map changed;
 * - `known.frac`: fraction of known cells among those the straight start-goal segment traverses, in the agent's own
 *   belief map (1 for `ideal` agents, whose map is the ground truth).
 */
const entries: [string, ExprContext[string]][] = [
  ["dist.m", { type: "number" }],
  ["vehicle", { type: "enum", values: ["uav", "ugv"] }],
  ["altitude", { type: "number" }],
  ...FEATURES.map((f): [string, ExprContext[string]] => [`profile.${f}`, { type: "boolean" }]),
  ["budget.total", { type: "number" }],
  ["replan.count", { type: "number" }],
  ["known.frac", { type: "number" }],
];

export const PLANNING_CONDITION_CONTEXT: ExprContext = Object.fromEntries(entries);

/** Variable names, sorted: the slot order is fixed by the compiler, this is the documented list. */
export const PLANNING_CONDITION_VARIABLES: readonly string[] = Object.keys(PLANNING_CONDITION_CONTEXT).sort();

/** What `known.frac` needs from a map: the planning grid's cell geometry and its unknown flag. */
export type KnownFractionGrid = Pick<PlanningGrid, "hasUnknown" | "isUnknown" | "cellI" | "cellJ" | "sizeX" | "sizeY" | "resolutionM">;

/**
 * `known.frac` (ADR-0037 addition of 2026-10-13): the fraction of known cells among those the straight segment from
 * `from` to `to` (metres) traverses, on the agent's own map. A map without unknown cells (the ground truth, which is an
 * `ideal` agent's map) gives exactly 1. A belief map (an `unknown` or prior start) is measured cell by cell, so a prior
 * counts only where it knows. Cells are visited by a grid DDA (Amanatides–Woo) from the start cell to the goal cell,
 * both included; a segment through an exact cell corner moves diagonally and does not visit the two side cells (fixed
 * rule, so the value is the same on every machine). Integer counts, one division: deterministic.
 */
export function knownFractionAlong(grid: KnownFractionGrid, from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): number {
  if (!grid.hasUnknown) return 1;
  const clampI = (v: number) => Math.min(grid.sizeX - 1, Math.max(0, v));
  const clampJ = (v: number) => Math.min(grid.sizeY - 1, Math.max(0, v));
  let i = clampI(grid.cellI(from.x));
  let j = clampJ(grid.cellJ(from.y));
  const i1 = clampI(grid.cellI(to.x));
  const j1 = clampJ(grid.cellJ(to.y));
  // Cell coordinates (a cell is one unit); both axes share the grid's resolution.
  const dx = (to.x - from.x) / grid.resolutionM;
  const dy = (to.y - from.y) / grid.resolutionM;
  const ux = from.x / grid.resolutionM;
  const uy = from.y / grid.resolutionM;
  const stepI = dx > 0 ? 1 : -1;
  const stepJ = dy > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  let tMaxX = dx === 0 ? Number.POSITIVE_INFINITY : (dx > 0 ? i + 1 - ux : ux - i) / Math.abs(dx);
  let tMaxY = dy === 0 ? Number.POSITIVE_INFINITY : (dy > 0 ? j + 1 - uy : uy - j) / Math.abs(dy);
  let total = 0;
  let unknown = 0;
  const count = () => {
    total++;
    if (grid.isUnknown(i, j)) unknown++;
  };
  for (let guard = grid.sizeX + grid.sizeY + 2; (i !== i1 || j !== j1) && guard > 0; guard--) {
    count();
    const moveI = i !== i1;
    const moveJ = j !== j1;
    const advI = () => {
      i += stepI;
      tMaxX += tDeltaX;
    };
    const advJ = () => {
      j += stepJ;
      tMaxY += tDeltaY;
    };
    if (moveI && moveJ) {
      if (tMaxX < tMaxY) advI();
      else if (tMaxY < tMaxX) advJ();
      else {
        advI();
        advJ();
      }
    } else if (moveI) advI();
    else advJ();
  }
  count();
  return (total - unknown) / total;
}
