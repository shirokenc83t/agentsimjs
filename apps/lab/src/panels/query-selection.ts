import { useSyncExternalStore } from "react";

/** The planning query the Inspector's table has selected: the Scene's stages overlay draws the same one (F2b M4). */
export interface QuerySelection {
  readonly agentId: string;
  readonly queryId: string;
}

let current: QuerySelection | undefined;
const listeners = new Set<() => void>();

/**
 * A small store beside the UI context's selection (ADR-0016): the time cursor, run and agent selection stay in the shared
 * context; which *query* of that agent is being looked at is a detail of two lazy panels, so it lives in this lazy
 * module and costs the initial chunk nothing.
 */
export const querySelection = {
  get: (): QuerySelection | undefined => current,
  set(next: QuerySelection | undefined): void {
    if (next?.agentId === current?.agentId && next?.queryId === current?.queryId) return;
    current = next;
    for (const l of listeners) l();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useQuerySelection(): QuerySelection | undefined {
  return useSyncExternalStore(querySelection.subscribe, querySelection.get);
}
