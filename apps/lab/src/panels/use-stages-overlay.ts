import type { SceneRenderer } from "@agentsim/ui";
import { useEffect, useMemo } from "react";
import type { SimClient } from "../sim/sim-client.ts";
import { useQuerySelection } from "./query-selection.ts";
import { selectedQueryRow, stageLinesOf } from "./stage-lines.ts";
import { usePlanQueries } from "./use-plan-queries.ts";

/**
 * The stages of the selected planning query for the Scene (F2b M4): the query picked in the Inspector's table, else the
 * latest of the viewed agent that has stages. Drawn from the geometry in the strategy trace, so it works live and from a
 * stored run alike. Everything is released when the overlay goes off, the agent changes or the panel closes.
 */
export function useStagesOverlay(sim: SimClient, renderer: SceneRenderer | undefined, on: boolean, agentId: string | undefined): void {
  const rows = usePlanQueries(sim, on && agentId ? agentId : "");
  const picked = useQuerySelection();
  const row = on && agentId ? selectedQueryRow(rows, picked) : undefined;
  // What changes the drawing: which query, and how much of it is known (its plan record arrives once, when it completes).
  const key = row ? `${row.agentId}/${row.queryId}/${row.completedTick ?? "-"}/${row.strategy?.searches.length ?? 0}` : "";
  const lines = useMemo(() => (row ? stageLinesOf(row) : undefined), [key]); // `key` names the row's content
  useEffect(() => {
    if (!renderer) return;
    renderer.setStages(lines);
    return () => renderer.setStages(undefined);
  }, [renderer, lines]);
}
