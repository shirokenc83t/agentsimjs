import { useUiContext } from "@agentsim/ui";
import { useCallback } from "react";
import { useAppActions } from "../../services.tsx";
import { resolveGapClick } from "../../sim/gap-click.ts";
import type { RunSnapshot } from "../../sim/run-source.ts";

/**
 * Moves the shared cursor to a moment of the run (ADR-0016 context sync): the Scene's agents, paths and belief overlay, the Inspector and the Explorer
 * follow it. A moment the storage does not hold yet (the gap of a live run) lands on the persisted head, as a click on the Timeline does. When the panels
 * still show the live run, the run is opened for scrubbing first: the cursor is set before, and a live run's cursor that was moved by hand is not
 * dragged back to the sim head (`syncRunContext`).
 */
export function useJump(snap: RunSnapshot): (tS: number, agentId?: string) => string | undefined {
  const { openReplay } = useAppActions();
  const dt = snap.run?.dtS ?? 0.1;
  return useCallback(
    (tS, agentId) => {
      const persisted = snap.persistedHeadTick ?? snap.simHeadTick;
      const r = resolveGapClick(Math.round(tS / dt), persisted, snap.simHeadTick);
      const ctx = useUiContext.getState();
      ctx.setSimTime(r.tick * dt);
      if (agentId !== undefined) ctx.select({ kind: "agent", id: agentId });
      if (snap.mode === "live" && snap.runId !== undefined) openReplay(snap.runId);
      return r.notice;
    },
    [snap.persistedHeadTick, snap.simHeadTick, snap.mode, snap.runId, dt, openReplay],
  );
}
