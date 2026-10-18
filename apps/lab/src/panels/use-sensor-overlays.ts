import type { SceneRenderer } from "@agentsim/ui";
import { useEffect } from "react";
import type { RunSource } from "../sim/run-source.ts";

/**
 * The viewed agent's sensor rays and topological layer for the Scene (ADR-0019 addition of 2026-10-12). While at least one is
 * on and an agent is selected, the worker is asked for the streams that are on (the ray recorder runs only then, and
 * only for that agent); everything is released when they go off, the agent changes or the panel closes: the streams stop,
 * the recorder is switched off and the drawn layers are cleared.
 */
export function useSensorOverlays(source: RunSource, renderer: SceneRenderer | undefined, rays: boolean, topology: boolean, agentId: string | undefined, runId: string | undefined): void {
  const on = (rays || topology) && agentId !== undefined && runId !== undefined;
  useEffect(() => {
    if (!renderer || !on || agentId === undefined) return;
    const stops: (() => void)[] = [];
    if (rays) {
      stops.push(
        source.subscribe("rays", (m) => {
          if (m.runId === runId && m.agentId === agentId) renderer.setRays(m.segments, m.hit);
        }),
      );
    }
    if (topology) {
      stops.push(
        source.subscribe("topology", (m) => {
          if (m.runId === runId && m.agentId === agentId) renderer.setTopologyOverlay(m.regions, m.frontiers);
        }),
      );
    }
    source.send({ type: "overlayWatch", agentId, rays, topology });
    return () => {
      for (const s of stops) s();
      source.send({ type: "overlayWatch", agentId: null, rays: false, topology: false });
      renderer.setRays(undefined, undefined);
      renderer.setTopologyOverlay(undefined, undefined);
    };
  }, [source, renderer, on, rays, topology, agentId, runId]);
}
