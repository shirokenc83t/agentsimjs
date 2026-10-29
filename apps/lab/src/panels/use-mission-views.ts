import { useEffect, useState } from "react";
import type { RunSource } from "../sim/run-source.ts";
import { missionViewOf, type MissionView } from "./mission-view.ts";

interface Cache {
  /** Records looked at so far, for the agents that have a mission (found among the config records, once). */
  scanned: number;
  ids: Set<string>;
  length: number;
  views: Map<string, MissionView>;
}
const caches = new WeakMap<RunSource, Cache>();
const NONE: Map<string, MissionView> = new Map();

/**
 * The progress of each agent's mission, from the run's trace records, shared by every panel that shows it: the agents with a mission are found once, among the records as they come
 * (the config records are the first of a run), so a run with no mission costs a look at each new record and nothing more; a run with one is followed for those agents only.
 */
export function missionViewsOf(source: RunSource): Map<string, MissionView> {
  const records = source.records();
  let c = caches.get(source);
  if (c === undefined || records.length < c.scanned) caches.set(source, (c = { scanned: 0, ids: new Set(), length: -1, views: NONE }));
  if (c.length === records.length) return c.views;
  for (; c.scanned < records.length; c.scanned++) {
    const r = records[c.scanned];
    if (r !== undefined && r.agentId !== undefined && r.kind === "lifecycle" && (r.payload as { op?: unknown; mind?: unknown } | undefined)?.op === "config" && (r.payload as { mind?: unknown }).mind !== undefined) c.ids.add(r.agentId);
  }
  c.length = records.length;
  if (c.ids.size === 0) {
    c.views = NONE;
    return NONE;
  }
  const views = new Map<string, MissionView>();
  for (const id of c.ids) {
    const v = missionViewOf(records, id);
    if (v !== undefined) views.set(id, v);
  }
  c.views = views;
  return views;
}

/** The progress of each agent's mission; recomputed when records arrive, like the agent views. Empty for a run with no mission. */
export function useMissionViews(source: RunSource): Map<string, MissionView> {
  const [views, setViews] = useState(() => missionViewsOf(source));
  useEffect(() => {
    setViews(missionViewsOf(source));
    return source.onRecords(() => setViews(missionViewsOf(source)));
  }, [source]);
  return views;
}
