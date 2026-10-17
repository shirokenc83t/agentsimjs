import { useEffect, useState } from "react";
import type { SimClient } from "../sim/sim-client.ts";
import { agentViews, type AgentViews } from "./agent-views.ts";

/**
 * Per-agent views (latest action, plan, reflex) derived from the run's trace records; recomputed only when
 * records arrive (≤ 10 Hz, UI-SPEC §10). Lives with the (lazy) panels, outside the initial chunk.
 */
export function useAgentViews(sim: SimClient): Map<string, AgentViews> {
  const [views, setViews] = useState(() => agentViews(sim.records()));
  useEffect(() => {
    setViews(agentViews(sim.records()));
    return sim.onRecords(() => setViews(agentViews(sim.records())));
  }, [sim]);
  return views;
}
