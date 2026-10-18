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
    const kept = c.mode === "live" && view.mode === "live" && c.runId !== undefined && view.runId !== undefined ? c.selection : undefined;
    c.setRun(view.runId, view.mode);
    const next = store.getState();
    if (kept && (kept.kind === "cell" || (kept.kind === "agent" && view.run?.agents.some((a) => a.id === kept.id)))) next.select(kept);
    if (view.mode === "live") next.setSimTime(view.simTimeS);
  } else if (view.mode === "live" && c.simTime !== view.simTimeS) {
    c.setSimTime(view.simTimeS);
  }
}
