import "./panels.css";
import { useUiContext } from "@agentsim/ui";
import { useCallback, useMemo, useState } from "react";
import { usePolled } from "../services.tsx";
import type { RunSnapshot, RunSource } from "../sim/run-source.ts";
import type { MapModel } from "./analysis/analysis-model.ts";
import { TopDownMap, type MapPick } from "./analysis/top-down-map.tsx";
import { useBlockedGrid } from "./analysis/use-blocked-grid.ts";

/** Points of an executed path the 2D tab draws at most per agent (the worker keeps at most 2048). */
const TRAIL_POINTS = 2048;

/**
 * The Scene's 2D tab (UI-SPEC section 3, ADR-0029): the same top-down map component as the Analysis workspace, fed by the run source the Scene shows: the live run's
 * executed paths and poses in a live run, the replay's at the cursor in a replay. A click on an agent selects it, as in the 3D view.
 */
export function Scene2dView(props: { readonly source: RunSource; readonly snap: RunSnapshot }) {
  const { source, snap } = props;
  const selection = useUiContext((s) => s.selection);
  const dims = snap.grid?.dims;
  const blocked = useBlockedGrid(source, dims, snap.runId);
  // The paths and the poses change every tick: read at the panel rate, like the rest of the panel.
  const [, setTick] = useState(0);
  usePolled(useCallback(() => setTick((n) => (n + 1) % 1_000_000), []), 100);
  const model: MapModel = useMemo(() => {
    const ids = snap.entityIds;
    return {
      widthM: dims ? dims.sizeX * dims.resolutionM : 100,
      heightM: dims ? dims.sizeY * dims.resolutionM : 100,
      blocked,
      trajectories: ids.map((id, i) => {
        const p = source.executedPath(id);
        const n = Math.min(p.count, TRAIL_POINTS);
        const points: { x: number; y: number }[] = [];
        for (let k = 0; k < n; k++) points.push({ x: p.points[k * 3] ?? 0, y: p.points[k * 3 + 1] ?? 0 });
        return { agentId: id, colorIndex: i, points };
      }),
      positions: ids.flatMap((id, i) => {
        const p = source.pose(i);
        return p ? [{ agentId: id, colorIndex: i, x: p.x, y: p.y }] : [];
      }),
      markers: [],
    };
    // The model is read again at the panel rate (`snap` is a new object each poll); the grid and the entities are what a new run changes.
  }, [source, snap, dims, blocked]);
  const onPick = (p: MapPick) => {
    if (p.agentId !== undefined) useUiContext.getState().select({ kind: "agent", id: p.agentId });
  };
  return <TopDownMap model={model} selectedAgent={selection?.kind === "agent" ? selection.id : undefined} onPick={onPick} label="Top-down map of the run: where the agents have been and are" />;
}
