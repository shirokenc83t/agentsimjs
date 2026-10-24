import type { SceneRenderer } from "@agentsim/ui";
import { useSyncExternalStore } from "react";

/**
 * The renderer of the Scene on screen, for the windows that draw from it (the Overview): the Scene publishes it when it is built and withdraws it when it goes.
 * One Scene at a time.
 */
let current: SceneRenderer | undefined;
const listeners = new Set<() => void>();

export function publishScene(r: SceneRenderer | undefined): void {
  current = r;
  for (const l of listeners) l();
}

export const getScene = (): SceneRenderer | undefined => current;

export function useScene(): SceneRenderer | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getScene,
    getScene,
  );
}
