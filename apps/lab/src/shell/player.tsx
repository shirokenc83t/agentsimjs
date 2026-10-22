import { formatSimTime, GLYPH, useUiContext } from "@agentsim/ui";
import { Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { useSource } from "../services.tsx";
import { gapLabel, resolveGapClick } from "../sim/gap-click.ts";
import type { RunSnapshot } from "../sim/run-source.ts";
import type { SimClient, SimSnapshot } from "../sim/sim-client.ts";
import { LazyAttentionTile, LazyPlayerMarks } from "../workspaces/registry.tsx";
import { trackLayout } from "./track.ts";

export const SPEEDS = [
  { label: "×0.5", hz: 5 },
  { label: "×1", hz: 10 },
  { label: "×2", hz: 20 },
  { label: "×4", hz: 40 },
] as const;

export interface PlayerProps {
  readonly sim: SimClient;
  /** The live run, as the sim worker reports it. */
  readonly snap: SimSnapshot;
  /** What the panels show: the live run, or a recording read from storage (the player is then the replay control, with its cursor). */
  readonly view: RunSnapshot | undefined;
  /** The one-row form of the Author, Data and Settings workspaces. */
  readonly compact: boolean;
  /** The run is recorded: the player offers to scrub it back and flags its marks. */
  readonly recorded: boolean;
  readonly busy: boolean;
  /** Re-run in the other time mode (a scenario run's mode is part of the run). */
  readonly onRerunInMode: (mode: "lockstep" | "realtime") => void;
  readonly onScrubBack: (runId: string) => void;
  readonly onBackToLive: () => void;
}

/**
 * The player (UI-SPEC §2): the one time control for the live run and for replay (ADR-0016), in a band under the top bar. Transport (play and pause, step, speed,
 * time mode), the sim clock, the scrub track with the saved range and flag markers, the LIVE or ◷ REPLAY state and telemetry tiles. In replay the band is hatched
 * and the track is the cursor: the F3a replay behaviour (persisted head, the gap "not saved yet", Follow saved, the click rule) is unchanged. The cursor is the shared
 * UI context's: the renderer and the source read it imperatively, so dragging re-renders only this band.
 */
export function Player(props: PlayerProps) {
  const { snap, view, compact, recorded } = props;
  const replay = view?.mode === "replay" && view.replay !== undefined;
  const dtS = view?.run?.dtS ?? snap.run?.dtS ?? 0.1;
  return (
    <section className={`player${replay ? " rp" : ""}${compact ? " compact" : ""}`} aria-label={replay ? "Player, replay of a stored run" : "Player, live run"} data-testid="player">
      <Transport {...props} replay={replay} />
      <div className="clock">
        <span className="lbl">{replay ? "REPLAY" : "SIM TIME"}</span>
        <ClockValue replay={replay} simTimeS={snap.simTimeS} />
      </div>
      {replay && view ? <ReplayScrub view={view} dtS={dtS} onBackToLive={props.onBackToLive} /> : <LiveScrub snap={snap} view={view} dtS={dtS} recorded={recorded} />}
      {!compact && <Telemetry snap={snap} recorded={recorded} />}
    </section>
  );
}

function ClockValue(props: { replay: boolean; simTimeS: number }) {
  // In replay the clock is the cursor; it re-renders with the cursor and nothing else.
  const cursor = useUiContext((s) => s.simTime);
  return (
    <span className="big mono" data-testid="player-clock">
      {formatSimTime(props.replay ? cursor : props.simTimeS)}
    </span>
  );
}

function Transport(props: PlayerProps & { replay: boolean }) {
  const { sim, snap, busy, replay, recorded, view } = props;
  const otherMode = snap.mode === "realtime" ? "lockstep" : "realtime";
  return (
    <div className="ply" role="toolbar" aria-label="Run control">
      {snap.running ? (
        <button type="button" className="pb pri" onClick={() => sim.pause()} aria-label="Pause" data-tip="Pause · Space" data-testid="pause">
          {GLYPH.paused}
        </button>
      ) : (
        <button type="button" className="pb pri" onClick={() => sim.play()} aria-label="Play" data-tip="Play · Space" data-testid="play">
          {GLYPH.running}
        </button>
      )}
      <button type="button" className="pb sm" onClick={() => sim.step()} aria-label="Step one tick" data-tip="Step one tick · ." data-testid="step">
        {GLYPH.running}| step
      </button>
      <select className="pb sm" value={snap.tickRateHz} aria-label="Speed" onChange={(e) => sim.setTickRate(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s.hz} value={s.hz}>
            {s.label}
          </option>
        ))}
      </select>
      {snap.run ? (
        // A scenario run's time mode is part of the run (header, runConfigHash): read-only while it is loaded.
        // Changing it starts a new run of the same scenario version (2026-10-09).
        <>
          <span className="pb sm static mono" data-testid="time-mode" title="The time mode is part of the run. Re-run to change it.">
            {snap.mode}
          </span>
          <button type="button" className="pb sm" onClick={() => !busy && props.onRerunInMode(otherMode)} aria-disabled={busy} data-testid="rerun-in-mode">
            re-run in {otherMode}
          </button>
        </>
      ) : (
        <select className="pb sm" value={snap.mode} aria-label="Time mode" onChange={(e) => sim.setMode(e.target.value === "realtime" ? "realtime" : "lockstep")}>
          <option value="lockstep">lockstep</option>
          <option value="realtime">realtime</option>
        </select>
      )}
      {!replay && recorded && view?.runId && (
        <button type="button" className="pb sm" onClick={() => props.onScrubBack(view.runId as string)} data-testid="scrub-back" data-tip="Look back at the run as it is saved (the run goes on)">
          « scrub back
        </button>
      )}
    </div>
  );
}

/** The live state: the run so far, what is saved of it, and its flags. */
function LiveScrub(props: { snap: SimSnapshot; view: RunSnapshot | undefined; dtS: number; recorded: boolean }) {
  const { snap, view, dtS, recorded } = props;
  const savedS = (view?.persistedHeadTick ?? 0) * dtS;
  const t = trackLayout({ headS: Math.min(savedS, snap.simTimeS), simHeadS: snap.simTimeS, shownS: snap.simTimeS, dtS });
  return (
    <div className="scrub">
      <div className="row">
        <span className="live" data-testid="player-state">
          ● LIVE
        </span>
        <span data-testid="player-tick">tick {snap.tick}</span>
      </div>
      <div className="track" role="img" aria-label="Run so far">
        {recorded && <div className="sv" style={{ width: `${t.savedPct}%` }} />}
        {recorded && view?.runId && (
          <Suspense fallback={null}>
            <LazyPlayerMarks runId={view.runId} headS={savedS} scaleS={t.scaleS} />
          </Suspense>
        )}
        <i className="hd" style={{ left: `${t.cursorPct}%` }} />
      </div>
    </div>
  );
}

/** The replay state: the recording read from storage, its cursor, the gap behind a live run, Follow saved and the way back. */
function ReplayScrub(props: { view: RunSnapshot; dtS: number; onBackToLive: () => void }) {
  const { view, dtS } = props;
  const source = useSource();
  const replay = view.replay as NonNullable<RunSnapshot["replay"]>;
  const simTime = useUiContext((s) => s.simTime);
  const head = replay.headS;
  const simHead = replay.simHeadS;
  const live = simHead !== undefined;
  // Scrubbing a live run starts on the persisted head; coming from a jump to an earlier moment (a click on the Timeline or the list) it stays there.
  const [follow, setFollow] = useState(live && useUiContext.getState().simTime >= head);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const track = useRef<HTMLDivElement>(null);
  const persistedTick = Math.round(head / dtS);
  const label = gapLabel(persistedTick, Math.round((simHead ?? head) / dtS), dtS);
  const shown = Math.min(simTime, head);
  const t = trackLayout({ headS: head, simHeadS: simHead, shownS: shown, dtS });

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
    const target = ((e.clientX - box.left) / box.width) * t.scaleS;
    const r = resolveGapClick(Math.round(target / dtS), persistedTick, Math.round((simHead ?? head) / dtS));
    setFollow(false);
    setNotice(r.notice);
    useUiContext.getState().setSimTime(r.tick * dtS);
  };

  return (
    <div className="scrub" data-testid="replay-bar">
      <div className="row">
        <span className="live rp" data-testid="player-state">
          {GLYPH.replay} REPLAY
        </span>
        <span className="hide-compact trunc" data-testid="replay-label">
          {GLYPH.replay} {live ? "Scrubbing" : "Replay of"} {view.runId} from storage (the live run is not touched)
        </span>
        <span className="muted hide-compact hide-narrow" data-testid="replay-pose-rate">
          {replay.poseRate}
        </span>
        <span className="sp" />
        {label !== undefined && (
          <span className="warn" data-testid="replay-gap">
            {label}
          </span>
        )}
        {notice !== undefined && (
          <span className="muted hide-compact" data-testid="replay-notice">
            {notice}
          </span>
        )}
        <span className="mono" data-testid="replay-time">
          {shown.toFixed(1)} s / {head.toFixed(1)} s
        </span>
        {live && (
          <label className="hide-compact">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="replay-follow" /> Follow saved
          </label>
        )}
        <button type="button" className="pb sm golive" onClick={props.onBackToLive} data-testid="replay-close" data-tip={live ? "Back to the live run" : "Close the replay"}>
          → {live ? "LIVE" : "Back to live"}
        </button>
      </div>
      <div className="track clickable" ref={track} onClick={onTrackClick} data-testid="replay-track" role="presentation">
        <div className="sv" style={{ width: `${t.savedPct}%` }} />
        {label !== undefined && <div className="gap" data-testid="replay-gap-area" style={{ left: `${t.gapLeftPct}%`, width: `${t.gapWidthPct}%` }} />}
        <Suspense fallback={null}>
          <LazyPlayerMarks runId={view.runId as string} headS={head} scaleS={t.scaleS} />
        </Suspense>
        <i className="hd" style={{ left: `${t.cursorPct}%` }} />
        {/* The keyboard control of the cursor: a slider over the track that does not take the pointer (a click is the track's, with the gap rule). */}
        <input
          type="range"
          className="cursor-input"
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
      </div>
    </div>
  );
}

function Telemetry(props: { snap: SimSnapshot; recorded: boolean }) {
  const { snap, recorded } = props;
  const budgetMs = 1000 / Math.max(1, snap.tickRateHz);
  const load = Math.min(100, (snap.tickTimeP95Ms / budgetMs) * 100);
  return (
    <div className="telem">
      <div className="tile">
        <span className="lbl">RATE</span>
        <span className="v mono">
          {snap.ticksPerSecond.toFixed(1)} <small>/{snap.tickRateHz} Hz</small>
        </span>
      </div>
      <div className="tile">
        <span className="lbl">TICK COST</span>
        <span className="v mono">
          {snap.tickTimeP95Ms.toFixed(1)} <small>/{budgetMs.toFixed(0)} ms</small>
        </span>
        <div className="meter">
          <i style={{ width: `${load}%`, background: load > 80 ? "var(--warn)" : "var(--ok)" }} />
        </div>
      </div>
      {snap.run && (
        <Suspense fallback={null}>
          <LazyAttentionTile />
        </Suspense>
      )}
      <div className="tile opt">
        <span className="lbl">AGENTS</span>
        <span className="v mono">{snap.entityIds.length}</span>
      </div>
      <div className="tile opt">
        <span className="lbl">REC</span>
        <span className={`v mono ${recorded ? "ok" : "muted"}`}>{recorded ? "● stored" : "○ none"}</span>
      </div>
    </div>
  );
}
