import Button from "@mui/material/Button";
import { useUiContext } from "@agentsim/ui";
import { useAppActions } from "../services.tsx";
import type { RunSnapshot } from "../sim/run-source.ts";

/**
 * What the Scene says while it shows a recording (ADR-0035 item 9): which run, how its poses were sampled, where the cursor is and where the recording ends,
 * a cursor to move (the Timeline of the Debug workspace comes later), and the way back to the live run. The cursor is the shared UI context's: the renderer
 * and the source read it imperatively, so dragging re-renders only this bar.
 */
export function ReplayBar(props: { snap: RunSnapshot; dtS: number }) {
  const { snap, dtS } = props;
  const simTime = useUiContext((s) => s.simTime);
  const { openReplay } = useAppActions();
  const head = snap.replay?.headS ?? 0;
  return (
    <div className="replay-bar" data-testid="replay-bar">
      <span data-testid="replay-label">▶ Replay of {snap.runId} from storage (the live run is not touched)</span>
      <span className="muted" data-testid="replay-pose-rate">{snap.replay?.poseRate}</span>
      <label>
        <span className="muted">time </span>
        <input
          type="range"
          min={0}
          max={head}
          step={dtS}
          value={Math.min(simTime, head)}
          onChange={(e) => useUiContext.getState().setSimTime(Number(e.target.value))}
          aria-label="Replay time"
          data-testid="replay-cursor"
        />
      </label>
      <span className="mono" data-testid="replay-time">
        {Math.min(simTime, head).toFixed(1)} s / {head.toFixed(1)} s
      </span>
      <Button size="small" variant="outlined" color="inherit" onClick={() => openReplay(undefined)} data-testid="replay-close">
        Back to live
      </Button>
    </div>
  );
}
