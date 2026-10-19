import { useEffect, useMemo, useState } from "react";
import type { RunSource } from "../sim/run-source.ts";
import { PlanQueryIndex, type QueryRow } from "./plan-queries.ts";

/**
 * The agent's planning queries, assembled incrementally from the run's trace records: a new batch costs its own size,
 * and the hook re-renders only when this agent's rows changed (records arrive at ≤ 10 Hz, UI-SPEC §10). Lives with the
 * (lazy) panels, outside the initial chunk.
 */
export function usePlanQueries(source: RunSource, agentId: string): readonly QueryRow[] {
  const index = useMemo(() => new PlanQueryIndex(), [source]);
  const [, bump] = useState(0);
  useEffect(() => {
    index.ingest(source.records());
    bump((n) => n + 1);
    return source.onRecords(() => {
      if (index.ingest(source.records()).has(agentId)) bump((n) => n + 1);
    });
  }, [source, index, agentId]);
  return index.queries(agentId);
}
