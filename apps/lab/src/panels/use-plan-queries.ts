import { useEffect, useMemo, useState } from "react";
import type { SimClient } from "../sim/sim-client.ts";
import { PlanQueryIndex, type QueryRow } from "./plan-queries.ts";

/**
 * The agent's planning queries, assembled incrementally from the run's trace records: a new batch costs its own size,
 * and the hook re-renders only when this agent's rows changed (records arrive at ≤ 10 Hz, UI-SPEC §10). Lives with the
 * (lazy) panels, outside the initial chunk.
 */
export function usePlanQueries(sim: SimClient, agentId: string): readonly QueryRow[] {
  const index = useMemo(() => new PlanQueryIndex(), [sim]);
  const [, bump] = useState(0);
  useEffect(() => {
    index.ingest(sim.records());
    bump((n) => n + 1);
    return sim.onRecords(() => {
      if (index.ingest(sim.records()).has(agentId)) bump((n) => n + 1);
    });
  }, [sim, index, agentId]);
  return index.queries(agentId);
}
