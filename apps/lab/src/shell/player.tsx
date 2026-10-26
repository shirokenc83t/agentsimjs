import { formatSimTime, GLYPH, useUiContext } from "@agentsim/ui";
import { Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { pendingAt, useQueuedCommands } from "../queued-commands.ts";
import { useSource } from "../services.tsx";
import { gapLabel, resolveGapClick } from "../sim/gap-click.ts";
import type { RunSnapshot } from "../sim/run-source.ts";
import type { SimClient, SimSnapshot } from "../sim/sim-client.ts";
import { LazyAttentionTile, LazyMissionNote } from "../workspaces/registry.tsx";
import { isFailure, type Mark } from "../panels/debug/marks.ts";
import { useRunMarks } from "../panels/debug/use-run-marks.ts";
import { KnowledgeStrip } from "./knowledge-band-view.tsx";
import { knowledgeAt, knowledgeWords, type KnowledgeBand } from "./knowledge-band.ts";
import { trackLayout } from "./track.ts";
import { useKnowledgeBand } from "./use-knowledge.ts";

export const SPEEDS = [
  { label: "×0.5", hz: 5 },
  { label: "×1", hz: 10 },
  { label: "×2", hz: 20 },
  { label: "×4", hz: 40 },
] as const;

/** What the player's Re-run does: a new run of the same scenario version, configuration and seed, live in lockstep, live in realtime, or headless (U-010 section 4). */
export type RerunChoice = "live-lockstep" | "live-realtime" | "headless";
const RERUN_WORDS: Record<RerunChoice, string> = { "live-lockstep": "live · lockstep", "live-realtime": "live · realtime", headless: "headless" };

export interface PlayerProps {
  readonly sim: SimClient;
  /** The live run, as the sim worker reports it. */
  readonly snap: SimSnapshot;
  /** What the panels show: the live run, or a recording read from storage (the player is then the replay control, with its cursor). */
  readonly view: RunSnapshot | undefined;
  /** The one-row form of the Configurations, Data and Settings workspaces. */
  /** The run is recorded: the player offers to scrub it back and flags its marks. */
  readonly recorded: boolean;
  readonly busy: boolean;
  /** Re-run the run shown: live in lockstep or in realtime (the time mode is part of a scenario run), or headless. */
  readonly onRerun: (how: RerunChoice) => void;
  /** Runs the run waiting at tick 0 headless (READY's second choice). */
  readonly onStartHeadless: () => void;
  /** The commands the run shown has recorded: a re-run applies them again. */
  readonly rerunCommands: number;
  /** How the run is recorded, for the summary of a run that waits to start: the profile's name, or why it is not recorded. */
  readonly recordingLabel: string;
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
  const { snap, view, recorded } = props;
  const replay = view?.mode === "replay" && view.replay !== undefined;
  const dtS = view?.run?.dtS ?? snap.run?.dtS ?? 0.1;
  return (
    <section className={`player${replay ? " rp" : ""}`} aria-label={replay ? "Player, replay of a stored run" : "Player, live run"} data-testid="player">
      <Transport {...props} replay={replay} />
      <div className="clock">
        <span className="lbl">{replay ? "Replay" : "Sim time"}</span>
        <ClockValue replay={replay} simTimeS={snap.simTimeS} />
        <Suspense fallback={null}>
          <LazyMissionNote />
        </Suspense>
      </div>
      {replay && view ? <ReplayScrub view={view} dtS={dtS} onBackToLive={props.onBackToLive} /> : <LiveScrub snap={snap} view={view} dtS={dtS} recorded={recorded} />}
      <Telemetry snap={snap} recorded={recorded} />
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
  // READY (U-010 section 4): a run that was just selected or made waits at tick 0 and nothing runs until the researcher chooses: live or headless. Step and the keys still work
  // (a way of going live, paused); what is replaced is the play button, which becomes the launch group.
  const queued = useQueuedText(snap.simTimeS);
  const summaryText = snap.run ? `${snap.mode} · ${snap.run.scenarioId} v${snap.run.scenarioVersion} · seed ${snap.run.seed} · profile ${props.recordingLabel}` : "";
  const ready = !replay && snap.run !== undefined && snap.tick === 0 && !snap.running && snap.headless !== true && snap.progress === undefined && !busy;
  return (
    <div className="ply" role="toolbar" aria-label="Run control">
      {ready && snap.run ? (
        <span className="ready-block">
          <span className="ready-start mono" data-testid="ready-start" role="group" aria-label={`Start ${snap.run.runId}`}>
            START <span className="rid">{snap.run.runId}</span> ·
            <button type="button" className="pb pri" onClick={() => sim.play()} aria-label="Start live" data-tip="Run it with the live view · Space" data-testid="play">
              {GLYPH.running} Live
            </button>
            <button type="button" className="pb" onClick={props.onStartHeadless} data-tip="No live view, as fast as lockstep allows: the Experiments monitor follows it" data-testid="ready-headless">
              ⇥ Headless
            </button>
          </span>
          {/* The second line of the launch cell: what is queued while something is, else what the run is. Never a third thing in the row. */}
          {queued !== undefined ? (
            <span className="ready-sum queued-note muted mono" data-testid="player-queued" title={`${queued} · ${summaryText}`}>
              {queued}
            </span>
          ) : (
            <span className="ready-sum muted mono" data-testid="ready-summary">
              {summaryText}
            </span>
          )}
        </span>
      ) : snap.running ? (
        <button type="button" className="pb pri" onClick={() => sim.pause()} aria-label="Pause" data-tip="Pause · Space" data-testid="pause">
          {GLYPH.paused}
        </button>
      ) : (
        <button type="button" className="pb pri" onClick={() => sim.play()} aria-label="Play" data-tip="Play · Space" data-testid="play">
          {GLYPH.running}
        </button>
      )}
      {!ready && queued !== undefined && (
        <span className="queued-note mono muted" data-testid="player-queued" title={queued}>
          {queued}
        </span>
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
        // A scenario run has its time mode as part of the run (header, runConfigHash): read-only while it is loaded. Changing it starts a new run of the same scenario version.
        <>
          <span className="pb sm static mono hide-1100" data-testid="time-mode" title="The time mode is part of the run. Re-run to change it.">
            {snap.mode}
          </span>
          <RerunSplit busy={busy} runId={snap.run.runId} commands={props.rerunCommands} onRerun={props.onRerun} />
        </>
      ) : (
        <select className="pb sm" value={snap.mode} aria-label="Time mode" onChange={(e) => sim.setMode(e.target.value === "realtime" ? "realtime" : "lockstep")}>
          <option value="lockstep">lockstep</option>
          <option value="realtime">realtime</option>
        </select>
      )}
      {!replay && recorded && view?.runId && (
        <button type="button" className="pb sm" onClick={() => props.onScrubBack(view.runId as string)} data-testid="scrub-back" data-tip="Look back at the run as it is saved (the run goes on)">
          «{" "}
          <span className="lbl-long">scrub back</span>
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
  const runId = recorded ? view?.runId : undefined;
  const band = useKnowledgeBand(runId, savedS);
  const marks = useRunMarks(runId, savedS);
  const strip = runId !== undefined;
  return (
    <div className="scrub">
      <div className="row">
        <span className="live" data-testid="player-state">
          {snap.headless ? `${GLYPH.running} HEADLESS` : "● LIVE"}
        </span>
        <span data-testid="player-tick">tick {snap.tick}</span>
        <KnowledgeLabel band={band} marks={marks} atS={Math.min(snap.simTimeS, savedS)} />
      </div>
      <div className={`track${strip ? " kbt" : ""}`} role="img" aria-label="Run so far">
        {recorded && <div className="sv" style={{ width: `${t.savedPct}%` }} />}
        {strip && <KnowledgeStrip band={band} marks={marks} runId={runId} startS={0} scaleS={t.scaleS} atS={Math.min(snap.simTimeS, savedS)} />}
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
  const startS = replay.startS ?? 0;
  const shown = Math.max(startS, Math.min(simTime, head));
  const derived = replay.derived;
  const t = trackLayout({ headS: head, simHeadS: simHead, shownS: shown, dtS, startS });
  const band = useKnowledgeBand(view.runId, head);
  const marks = useRunMarks(view.runId, head);

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
    const target = startS + ((e.clientX - box.left) / box.width) * (t.scaleS - startS);
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
        <span className="trunc" data-testid="replay-label" title={`${live ? "Scrubbing" : "Replay of"} ${view.runId} from storage: the live run is not touched`}>
          {GLYPH.replay} {live ? "Scrubbing" : "Replay of"} {view.runId}
        </span>
        {derived !== undefined && <DerivedMark derived={derived} />}
        <span className="muted hide-narrow" data-testid="replay-pose-rate">
          {replay.poseRate}
        </span>
        <KnowledgeLabel band={band} marks={marks} atS={shown} />
        <span className="sp" />
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
        <span className="mono" data-testid="replay-time">
          {shown.toFixed(1)} s / {head.toFixed(1)} s
        </span>
        {live && (
          <label>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="replay-follow" /> Follow saved
          </label>
        )}
        <button type="button" className="pb sm golive" onClick={props.onBackToLive} data-testid="replay-close" data-tip={live ? "Back to the live run" : "Close the replay"}>
          → {live ? "LIVE" : "Back to live"}
        </button>
      </div>
      <div className="track clickable kbt" ref={track} onClick={onTrackClick} data-testid="replay-track" role="presentation">
        <div className="sv" style={{ width: `${t.savedPct}%` }} />
        <KnowledgeStrip band={band} marks={marks} runId={view.runId} startS={startS} scaleS={t.scaleS} atS={shown} />
        {label !== undefined && <div className="gap" data-testid="replay-gap-area" style={{ left: `${t.gapLeftPct}%`, width: `${t.gapWidthPct}%` }} />}
        <i className="hd" style={{ left: `${t.cursorPct}%` }} />
        {/* The keyboard control of the cursor: a slider over the track that does not take the pointer (a click is the track's, with the gap rule). */}
        <input
          type="range"
          className="cursor-input"
          min={startS}
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

/**
 * Line 1 of the swarm knowledge band, above the strip (U-015): what the swarm knows and how much of it matches the truth at the cursor, the reflexes and failures so far, labelled as observer data;
 * the definition, the rate, the agents and the gaps are in the tooltip. A recorded run with no belief sample says so.
 */
function KnowledgeLabel(props: { band: KnowledgeBand; marks: readonly Mark[]; atS: number }) {
  const { band, atS } = props;
  if (band.points.length === 0) {
    return (
      <span className="kb-label mono" data-testid="player-knowledge" title="This recording profile holds no samples of the beliefs against the truth: the swarm knowledge band has nothing to draw from.">
        swarm knowledge · no belief samples in this recording profile <span className="muted">· observer</span>
      </span>
    );
  }
  const p = knowledgeAt(band, atS);
  const upTo = props.marks.filter((m) => m.t <= atS);
  const reflexes = upTo.filter((m) => m.kind === "reflex").length;
  const failures = upTo.filter(isFailure).length;
  return (
    <span className="kb-label mono" data-testid="player-knowledge" title={knowledgeWords(band, atS)}>
      swarm knows {p === undefined ? "–" : `${p.knownPct.toFixed(0)} %`} of what it can reach · belief matches truth {p === undefined ? "–" : `${p.matchPct.toFixed(0)} %`} · {reflexes} reflex{reflexes === 1 ? "" : "es"} · {failures} failure{failures === 1 ? "" : "s"}{" "}
      <span className="muted">· observer</span>
    </span>
  );
}

/** A derived run in the player: where it comes from, its window and whether its checkpoints were reproduced (ADR-0035 section 3). */
function DerivedMark(props: { derived: NonNullable<NonNullable<RunSnapshot["replay"]>["derived"]> }) {
  const d = props.derived;
  return (
    <span className="derived-mark mono" data-testid="player-derived" title={`A re-simulated window of ${d.parentRunId}: ${d.status === "matches" ? "every recorded checkpoint in it was reproduced" : `the first checkpoint that was not reproduced is at tick ${d.divergenceTick ?? "?"}`}`}>
      ◇ of {d.parentRunId} · {d.t0S.toFixed(1)}–{d.t1S.toFixed(1)} s · {d.status === "matches" ? <span className="ok">✓ matches</span> : <span className="danger">{GLYPH.fail} divergent @{d.divergenceTick ?? "?"}</span>}
    </span>
  );
}

function Telemetry(props: { snap: SimSnapshot; recorded: boolean }) {
  const { snap, recorded } = props;
  const budgetMs = 1000 / Math.max(1, snap.tickRateHz);
  const load = Math.min(100, (snap.tickTimeP95Ms / budgetMs) * 100);
  return (
    <div className="telem">
      <div className="tile">
        <span className="lbl">Rate</span>
        <span className="v mono">
          {snap.headless ? (
            <>
              {Math.round(snap.ticksPerSecond).toLocaleString("en")} <small>ticks/s</small>
            </>
          ) : (
            <>
              {snap.ticksPerSecond.toFixed(1)} <small>/{snap.tickRateHz} Hz</small>
            </>
          )}
        </span>
      </div>
      <div className="tile">
        <span className="lbl">Tick cost</span>
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
        <span className="lbl">Agents</span>
        <span className="v mono">{snap.entityIds.length}</span>
      </div>
      <div className="tile opt">
        <span className="lbl">Rec</span>
        <span className={`v mono ${recorded ? "ok" : "muted"}`}>{recorded ? "● stored" : "○ none"}</span>
      </div>
    </div>
  );
}

/**
 * The split Re-run button (U-010 section 4): the label repeats the last choice and a click does it again; the caret opens the three ways (live in lockstep `Ctrl+R`, live in
 * realtime, headless `Ctrl+Shift+R`) and says what they share: the scenario, the configuration, the seed and the commands of the run.
 */
function RerunSplit(props: { busy: boolean; runId: string; commands: number; onRerun: (how: RerunChoice) => void }) {
  const [last, setLast] = useState<RerunChoice>("live-lockstep");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const run = (how: RerunChoice) => {
    if (props.busy) return;
    setLast(how);
    setOpen(false);
    props.onRerun(how);
  };
  const items: readonly { how: RerunChoice; key?: string }[] = [{ how: "live-lockstep", key: "Ctrl+R" }, { how: "live-realtime" }, { how: "headless", key: "Ctrl+Shift+R" }];
  return (
    <span className="rerun-split" ref={box}>
      <button type="button" className="pb sm" onClick={() => run(last)} aria-disabled={props.busy} data-testid="player-rerun" data-tip={`Run it again: ${RERUN_WORDS[last]}`}>
        ⟲ Re-run{last === "live-lockstep" ? "" : ` · ${RERUN_WORDS[last]}`}
      </button>
      <button type="button" className="pb sm caret" aria-haspopup="menu" aria-expanded={open} aria-label="Re-run: choose how" onClick={() => setOpen((o) => !o)} data-testid="rerun-menu">
        ▾
      </button>
      {open && (
        <div className="rerun-pop" role="menu" aria-label="Re-run" data-testid="rerun-pop">
          {items.map((it) => (
            <button key={it.how} type="button" role="menuitem" className="tb" onClick={() => run(it.how)} data-testid={`rerun-${it.how}`}>
              re-run {RERUN_WORDS[it.how]}
              {it.key && <span className="k"> {it.key}</span>}
            </button>
          ))}
          <p className="muted mono rerun-same" data-testid="rerun-same">
            same scenario, config, seed and the {props.commands} command{props.commands === 1 ? "" : "s"} of {props.runId}
          </p>
        </div>
      )}
    </span>
  );
}

/** What waits for the next tick, next to Play (U-011 section 5): "1 command queued · ugv-001 explore". Nothing when nothing waits. */
/** What is queued, in words (`1 command queued · ugv-001 explore`), or undefined when nothing waits. */
function useQueuedText(simTimeS: number): string | undefined {
  const waiting = pendingAt(useQueuedCommands(), simTimeS);
  if (waiting.length === 0) return undefined;
  const last = waiting[waiting.length - 1];
  return `${waiting.length} command${waiting.length === 1 ? "" : "s"} queued${last ? ` · ${last.agentId} ${last.op}` : ""}`;
}
