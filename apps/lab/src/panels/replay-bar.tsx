import Button from "@mui/material/Button";
import { useUiContext } from "@agentsim/ui";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useAppActions, useSource } from "../services.tsx";
import { gapLabel, resolveGapClick } from "../sim/gap-click.ts";
import type { RunSnapshot } from "../sim/run-source.ts";

/**
 * What the Scene says while it shows a recording (ADR-0035 item 9 and 12): which run, how its poses were sampled, the Timeline with the cursor, and the way
 * back. For a live run being recorded the Timeline also shows what is not saved yet, hatched after the persisted head ("not saved yet: N ticks (S s)"): a
 * click there lands on the persisted head, with a notice, and nothing is asked of storage for the moment that was clicked. "Live" gives the panels the sim
 * head back; "Follow saved" keeps the cursor on the persisted head as it grows. The cursor is the shared UI context's: the renderer and the source read it
 * imperatively, so dragging re-renders only this bar.
 */
export function ReplayBar(props: { snap: RunSnapshot; dtS: number }) {
  const { snap, dtS } = props;
  const source = useSource();
  const simTime = useUiContext((s) => s.simTime);
  const { openReplay } = useAppActions();
  const head = snap.replay?.headS ?? 0;
  const simHead = snap.replay?.simHeadS;
  const live = simHead !== undefined;
  const scale = Math.max(simHead ?? 0, head, dtS);
  // Scrubbing a live run starts on the persisted head; coming from a jump to an earlier moment (a click on the Timeline or the list) it stays there.
  const [follow, setFollow] = useState(live && useUiContext.getState().simTime >= head);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const track = useRef<HTMLDivElement>(null);
  const persistedTick = Math.round(head / dtS);
  const label = gapLabel(persistedTick, Math.round((simHead ?? head) / dtS), dtS);

  // Following the persisted head: the cursor goes to it now and every time it moves.
  useEffect(() => {
    if (!follow) return;
    const go = () => useUiContext.getState().setSimTime(source.snapshot().replay?.headS ?? 0);
    go();
    return source.onHead(go);
  }, [follow, source]);

  const onTrackClick = (e: MouseEvent) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const target = ((e.clientX - box.left) / box.width) * scale;
    const r = resolveGapClick(Math.round(target / dtS), persistedTick, Math.round((simHead ?? head) / dtS));
    setFollow(false);
    setNotice(r.notice);
    useUiContext.getState().setSimTime(r.tick * dtS);
  };

  const shown = Math.min(simTime, head);
  return (
    <div className="replay-bar" data-testid="replay-bar">
      <span data-testid="replay-label">▶ {live ? "Scrubbing" : "Replay of"} {snap.runId} from storage (the live run is not touched)</span>
      <span className="muted" data-testid="replay-pose-rate">{snap.replay?.poseRate}</span>
      <div className="replay-track" ref={track} onClick={onTrackClick} data-testid="replay-track" role="presentation">
        <div className="replay-saved" style={{ width: `${(head / scale) * 100}%` }} />
        {label !== undefined && <div className="replay-gap" data-testid="replay-gap-area" style={{ left: `${(head / scale) * 100}%`, width: `${(((simHead ?? head) - head) / scale) * 100}%` }} />}
        <div className="replay-cursor-mark" style={{ left: `${(shown / scale) * 100}%` }} />
      </div>
      {label !== undefined && (
        <span className="warn" data-testid="replay-gap">
          {label}
        </span>
      )}
      {notice !== undefined && (
        <span className="muted" data-testid="replay-notice">
          {notice}
        </span>
      )}
      <label>
        <span className="muted">time </span>
        <input
          type="range"
          min={0}
          max={head}
          step={dtS}
          value={shown}
          onChange={(e) => {
            setFollow(false);
            setNotice(undefined);
            useUiContext.getState().setSimTime(Number(e.target.value));
          }}
          aria-label="Replay time"
          data-testid="replay-cursor"
        />
      </label>
      <span className="mono" data-testid="replay-time">
        {shown.toFixed(1)} s / {head.toFixed(1)} s
      </span>
      {live && (
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="replay-follow" /> Follow saved
        </label>
      )}
      <Button size="small" variant="outlined" color="inherit" onClick={() => openReplay(undefined)} data-testid="replay-close">
        {live ? "Live" : "Back to live"}
      </Button>
    </div>
  );
}
