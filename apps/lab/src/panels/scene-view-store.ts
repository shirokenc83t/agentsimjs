import type { GridViewMode } from "@agentsim/ui";
import { useSyncExternalStore } from "react";
import type { MapOverlay } from "./use-belief-overlay.ts";

/**
 * What the Scene shows now, for the Legend window to explain: the grid view, the map overlay and the overlays switched on. The Scene writes it as its toolbar
 * changes; the Legend reads it.
 */
export interface SceneViewState {
  readonly mode: GridViewMode;
  readonly overlay: MapOverlay;
  readonly rays: boolean;
  readonly topology: boolean;
  readonly stages: boolean;
  readonly explore: boolean;
  /** The Strategy test's result is drawn. */
  readonly sandbox: boolean;
}

const DEFAULT: SceneViewState = { mode: "occupancy", overlay: "truth", rays: false, topology: false, stages: false, explore: false, sandbox: false };
let state = DEFAULT;
const listeners = new Set<() => void>();

export function publishSceneView(next: SceneViewState): void {
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const l of listeners) l();
}

export const getSceneView = (): SceneViewState => state;

export function useSceneView(): SceneViewState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSceneView,
    getSceneView,
  );
}
