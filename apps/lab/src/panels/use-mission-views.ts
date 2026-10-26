import { useEffect, useState } from "react";
import type { RunSource } from "../sim/run-source.ts";
import { missionViews, type MissionView } from "./mission-view.ts";

/** The progress of each agent's mission, from the run's trace records; recomputed when records arrive, like the agent views. Empty for a run with no mission. */
export function useMissionViews(source: RunSource): Map<string, MissionView> {
  const [views, setViews] = useState(() => missionViews(source.records()));
  useEffect(() => {
    setViews(missionViews(source.records()));
    return source.onRecords(() => setViews(missionViews(source.records())));
  }, [source]);
  return views;
}
