import { useEffect, useState } from "react";
import type { RunSource } from "../sim/run-source.ts";
import { agentViews, type AgentViews } from "./agent-views.ts";

/**
 * Per-agent views (latest action, plan, reflex) derived from the run's trace records; recomputed only when
 * records arrive (≤ 10 Hz, UI-SPEC §10). Lives with the (lazy) panels, outside the initial chunk.
 */
export function useAgentViews(source: RunSource): Map<string, AgentViews> {
  const [views, setViews] = useState(() => agentViews(source.records()));
  useEffect(() => {
    setViews(agentViews(source.records()));
    return source.onRecords(() => setViews(agentViews(source.records())));
  }, [source]);
  return views;
}
