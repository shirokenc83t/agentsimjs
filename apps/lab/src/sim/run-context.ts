import type { UiContextState } from "@agentsim/ui";
import type { RunSnapshot } from "./run-source.ts";

/**
 * Keeps the shared UI context (ADR-0016) in line with the run source: a new run (or another mode) becomes the context's run
 * and starts its cursor afresh; while the run is live the cursor follows the sim head; in replay the cursor is the user's and
 * is never moved from here. Called at the panel poll rate (≤ 10 Hz), never per frame.
 *
 * Selection: opening another run resets it (the store's rule: it belongs to the previous run). A live run replaced by another
 * live run keeps what the researcher was looking at when that still exists in the new run (an agent of the same ID, or a cell:
 * a re-run of the same scenario with another configuration, which is how the lab is used, keeps its viewed agent).
 */
export function syncRunContext(store: { getState(): UiContextState }, view: Pick<RunSnapshot, "mode" | "runId" | "simTimeS"> & { readonly run?: { readonly agents: readonly { readonly id: string }[] } | undefined }): void {
  const c = store.getState();
  if (c.runId !== view.runId || c.mode !== view.mode) {
    const liveToLive = c.mode === "live" && view.mode === "live" && c.runId !== undefined && view.runId !== undefined;
    // The same run going from live to a replay of itself (scrubbing it back) keeps where the cursor and the selection are: that is where the user was looking.
    const sameRunScrub = c.mode === "live" && view.mode === "replay" && c.runId === view.runId;
    // Live again from a replay of the same run (the Live button) keeps it too: the run is the one it was looking at.
    const sameRunLive = c.mode === "replay" && view.mode === "live" && c.runId === view.runId;
    const kept = liveToLive || sameRunScrub || sameRunLive ? c.selection : undefined;
    const cursor = c.simTime;
    c.setRun(view.runId, view.mode);
    const next = store.getState();
    if (kept && (kept.kind === "cell" || (kept.kind === "agent" && (sameRunScrub || sameRunLive || view.run?.agents.some((a) => a.id === kept.id))))) next.select(kept);
    if (sameRunScrub) next.setSimTime(cursor);
    else if (view.mode === "live") {
      next.setSimTime(view.simTimeS);
      followed.set(store, view.simTimeS);
    }
  } else if (view.mode === "live" && c.simTime !== view.simTimeS) {
    // The cursor follows the sim head while the user has not moved it (a cursor set by hand, to scrub back, stays where it was put).
    if (c.simTime === (followed.get(store) ?? c.simTime)) {
      c.setSimTime(view.simTimeS);
      followed.set(store, view.simTimeS);
    }
  }
}

/** The cursor value this module last set while following the live run, per store: a different value means the user moved it. */
const followed = new WeakMap<object, number>();
