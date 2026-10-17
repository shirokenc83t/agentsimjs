import { ChunkQueue, type SceneRenderer } from "@agentsim/ui";
import { useEffect } from "react";
import type { SimClient } from "../sim/sim-client.ts";

/** What the Scene's map overlay shows: the ground truth (the default), the viewed agent's own map, or the difference. */
export type MapOverlay = "truth" | "belief" | "difference";

/**
 * The belief overlay of the viewed agent (ADR-0027, ADR-0019 addition of 2026-10-12). While the overlay is on and an agent
 * with a map of its own is selected: the renderer gets a queue and a belief atlas, the worker is asked for that agent's
 * belief chunks (dirty ones only, one agent at a time) and every chunk goes into the queue. Anything else releases it all:
 * the stream stops, the atlas is disposed, so one agent's map is in memory at a time and none while the overlay is off.
 */
export function useBeliefOverlay(sim: SimClient, renderer: SceneRenderer | undefined, overlay: MapOverlay, agentId: string | undefined, hasOwnMap: boolean, runId: string | undefined, chunksX: number): void {
  const on = overlay !== "truth" && agentId !== undefined && hasOwnMap && runId !== undefined && chunksX > 0;
  useEffect(() => {
    if (!renderer || !on || agentId === undefined) return;
    const queue = new ChunkQueue(chunksX);
    renderer.setBeliefLayer(queue);
    const stop = sim.subscribe("beliefChunks", (m) => {
      if (m.runId === runId && m.agentId === agentId) queue.push(m.coords, m.data);
    });
    sim.send({ type: "beliefWatch", agentId });
    return () => {
      stop();
      sim.send({ type: "beliefWatch", agentId: null });
      renderer.setBeliefLayer(undefined);
    };
  }, [sim, renderer, on, agentId, runId, chunksX]);
  useEffect(() => renderer?.setBeliefMode(overlay), [renderer, overlay, on]);
}
