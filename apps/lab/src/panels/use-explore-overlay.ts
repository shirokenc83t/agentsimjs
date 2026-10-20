import type { GridSpec, SceneRenderer } from "@agentsim/ui";
import { useEffect, useMemo, useState } from "react";
import type { RunSource } from "../sim/run-source.ts";
import { explorationOf } from "./explore-state.ts";

/**
 * The viewed agent's exploration for the Scene (ADR-0040): the area of its iteration and its marked targets, drawn from the
 * run's records up to the moment shown, so it works live and from a stored run alike. Released when the overlay goes off, the
 * agent changes or the panel closes.
 */
export function useExploreOverlay(source: RunSource, renderer: SceneRenderer | undefined, on: boolean, agentId: string | undefined, grid: GridSpec | undefined, simTimeS: number): void {
  const [rev, bump] = useState(0);
  const active = on && agentId !== undefined && grid !== undefined;
  useEffect(() => (active ? source.onRecords(() => bump((n) => n + 1)) : undefined), [source, active]);
  const sizeX = grid?.dims.sizeX;
  const res = grid?.dims.resolutionM;
  const view = useMemo(
    () => (active && agentId !== undefined && sizeX !== undefined && res !== undefined ? explorationOf(source.records(), agentId, simTimeS, { sizeX, resolutionM: res }) : undefined),
    // `rev` names the records received so far; `simTimeS` the moment shown.
    [source, active, agentId, sizeX, res, rev, simTimeS],
  );
  useEffect(() => {
    if (!renderer) return;
    renderer.setExploration(view);
    return () => renderer.setExploration(undefined);
  }, [renderer, view]);
}
