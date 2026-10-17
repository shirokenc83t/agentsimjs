import type { StrategyTestResult } from "@agentsim/scenarios";
import type { StageLine } from "@agentsim/ui";
import { strategyViewOf, type QueryRow } from "./plan-queries.ts";
import type { QuerySelection } from "./query-selection.ts";

/**
 * The lines the stages overlay draws for a query, from the geometry of each search in its strategy trace (ADR-0037 seventh
 * addition, item 14): the coarse path of a refine, then each leg in order. A search that found nothing has none. Anytime
 * passes each improve on the last, so only the last pass that found a path is drawn. A query without a strategy trace (plain,
 * running, interrupted) has no stages: its path is the planned path the path layer already draws.
 */
export function stageLinesOf(row: QueryRow | undefined): StageLine[] {
  const searches = row?.strategy?.searches ?? [];
  const lines: StageLine[] = [];
  const lastPass = searches.map((s, i) => (s.role === "pass" && s.waypoints && s.waypoints.length >= 2 ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  searches.forEach((s, i) => {
    const w = s.waypoints;
    if (!w || w.length < 2) return;
    if (s.role === "pass" && i !== lastPass) return;
    const points = new Float32Array(w.length * 2);
    w.forEach(([x, y], k) => {
      points[2 * k] = x;
      points[2 * k + 1] = y;
    });
    lines.push({ role: s.role === "coarse" ? "coarse" : "leg", points });
  });
  return lines;
}

/** The query the overlay follows: the one selected in the Inspector's table (for this agent), else the latest that has stages. */
export function selectedQueryRow(rows: readonly QueryRow[], picked: QuerySelection | undefined): QueryRow | undefined {
  const hasStages = (r: QueryRow) => (r.strategy?.searches ?? []).some((s) => s.waypoints !== undefined);
  const chosen = picked ? rows.find((r) => r.agentId === picked.agentId && r.queryId === picked.queryId) : undefined;
  if (chosen) return chosen;
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k];
    if (r && hasStages(r)) return r;
  }
  return undefined;
}

/** A Strategy test result as a query row, so the Inspector shows it with the same detail view as a run's query. */
export function sandboxRow(agentId: string, r: StrategyTestResult): QueryRow {
  return {
    queryId: "test",
    agentId,
    seq: 0,
    status: r.status,
    algorithm: r.planner,
    submittedTick: 1,
    completedTick: r.ticks,
    expansionsCharged: r.expansionsCharged,
    restarts: [],
    interruptions: 0,
    legs: r.legs.map((l) => ({ index: l.index, count: l.count, last: l.last, tick: l.tick })),
    strategy: strategyViewOf(r.strategy),
    waypoints: r.waypoints,
  };
}

/** What the sandbox overlay draws: the stages of a strategy, or the path of a plain algorithm as one leg. */
export function sandboxLines(r: StrategyTestResult): StageLine[] {
  if (r.strategy) return stageLinesOf(sandboxRow("", r));
  if (r.waypoints.length < 2) return [];
  const points = new Float32Array(r.waypoints.length * 2);
  r.waypoints.forEach(([x, y], k) => {
    points[2 * k] = x;
    points[2 * k + 1] = y;
  });
  return [{ role: "leg", points }];
}
