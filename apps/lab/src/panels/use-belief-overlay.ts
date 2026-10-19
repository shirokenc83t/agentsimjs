import { ChunkQueue, type SceneRenderer } from "@agentsim/ui";
import { useEffect } from "react";
import type { RunSource } from "../sim/run-source.ts";

/** What the Scene's map overlay shows: the ground truth (the default), the viewed agent's own map, or the difference. */
export type MapOverlay = "truth" | "belief" | "difference";

/**
 * The belief overlay of the viewed agent (ADR-0027, ADR-0019 addition of 2026-10-12). While the overlay is on and an agent
 * with a map of its own is selected: the renderer gets a queue and a belief atlas, the source is asked for that agent's
 * belief chunks (live: the worker's dirty ones, one agent at a time) and every chunk goes into the queue. Anything else releases it all:
 * the stream stops, the atlas is disposed, so one agent's map is in memory at a time and none while the overlay is off.
 */
export function useBeliefOverlay(source: RunSource, renderer: SceneRenderer | undefined, overlay: MapOverlay, agentId: string | undefined, hasOwnMap: boolean, runId: string | undefined, chunksX: number): void {
  const on = overlay !== "truth" && agentId !== undefined && hasOwnMap && runId !== undefined && chunksX > 0;
  useEffect(() => {
    if (!renderer || !on || agentId === undefined) return;
    const queue = new ChunkQueue(chunksX);
    renderer.setBeliefLayer(queue);
    const release = source.watchBelief(runId, agentId, queue);
    return () => {
      release();
      renderer.setBeliefLayer(undefined);
    };
  }, [source, renderer, on, agentId, runId, chunksX]);
  useEffect(() => renderer?.setBeliefMode(overlay), [renderer, overlay, on]);
}
