import "../panels.css";
import { formatBytes, GLYPH, KIND_STYLE } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { summary } from "../debug/log-rows.ts";
import type { Mark } from "../debug/marks.ts";
import { KnowledgeStrip } from "../../shell/knowledge-band-view.tsx";
import { knowledgeShown, knowledgeWords, type KnowledgeBand } from "../../shell/knowledge-band.ts";
import { averageRates, estimateVolume, etaS, formatDuration, fractionDone, grouped, snapshotMarks, sparkPoints, speedLabel, waitingLabel, type Progress } from "./monitor-model.ts";

/** One sparkline of the monitor: a metric of the run over its sim time. */
export interface Spark {
  readonly name: string;
  readonly title: string;
  readonly unit: string;
  readonly points: readonly { readonly t: number; readonly v: number }[];
}

export interface MonitorViewProps {
  readonly progress: Progress | undefined;
  /** The tick in sim seconds of the run shown. */
  readonly dtS: number;
  readonly run: { readonly runId: string; readonly label: string; readonly profileName: string | undefined; readonly profileHash: string | undefined } | undefined;
  /** What the run has stored so far, in bytes (the sum of its kinds), or undefined before it is known. */
  readonly storedBytes: number | undefined;
  /** The sampled event stream: the latest rows and what the display says of its sampling. */
  readonly stream: { readonly rows: readonly TraceRecord[]; readonly totalMatched: number; readonly totalShown: number; readonly sampled: boolean };
  readonly sparks: readonly Spark[];
  /** The swarm knowledge band of the run (observer data), its marks and the sim time it stands for: shown under the metrics when the run has samples. */
  readonly knowledge?: { readonly band: KnowledgeBand; readonly marks: readonly Mark[]; readonly runId: string; readonly endS: number } | undefined;
  /** The storage writer's state as the worker reports it (`ok`, or why the run waits). */
  readonly writer: { readonly state: "ok" | "storage_backpressure" | "storage_quota"; readonly backlogRecords: number } | undefined;
  readonly actions: { pause(): void; play(): void; stop(): void; openDebug(): void; openAnalysis: (() => void) | undefined; rerunHeadless?: (() => void) | undefined };
}

/** How a finished run ended, in words: its end condition reached, or stopped before it (or with none). */
function endCondition(p: Progress, stoppedEarly: boolean): string {
  if (p.untilS === undefined) return "stopped (the run had no end condition)";
  return stoppedEarly ? `before its end condition (sim time ${formatDuration(p.untilS)})` : `end condition: sim time ${formatDuration(p.untilS)} reached`;
}

const writerWords: Record<"ok" | "storage_backpressure" | "storage_quota", string> = {
  ok: "writing, keeping up",
  storage_backpressure: "behind: the run waits for it (wall time only)",
  storage_quota: "the quota is near its limit: the run is paused",
};

/**
 * The headless run monitor (ADR-0029, ADR-0035 section 7): while a run goes as fast as lockstep allows and shows nothing live, where it is, how fast, what it waits for, what
 * it writes and what happens in it. Every number comes from the worker's progress message (its own wall clock), so the view is a function of its props.
 */
export function HeadlessMonitorView(props: MonitorViewProps) {
  const { progress: p, run } = props;
  if (p === undefined || run === undefined) {
    return (
      <div className="panel hm" data-testid="headless-monitor" data-state="none">
        <div className="hm-empty-box" data-testid="hm-empty">
          <p className="hm-empty-line mono">
            <span className="muted">No headless run</span>
            {props.actions.rerunHeadless !== undefined && (
              <button type="button" className="btn pri" onClick={props.actions.rerunHeadless} data-testid="hm-rerun-headless">
                Re-run headless <span className="k">Ctrl+Shift+R</span>
              </button>
            )}
          </p>
          <p className="muted hm-empty">
            Run headless (the player, the run popover, Configurations or the palette) runs the scenario again with no live view, as fast as lockstep allows, always recorded. Where it is, how fast and what it writes are shown here.
          </p>
        </div>
      </div>
    );
  }
  const frac = fractionDone(p);
  const eta = etaS(p);
  const state = p.done ? "done" : !p.headless ? "live" : p.running ? "running" : "paused";
  const stoppedEarly = p.done && p.untilS !== undefined && p.simTimeS < p.untilS - 1e-6;
  const volume = estimateVolume(props.storedBytes, p.simTimeS, p.untilS);
  // A run that is not running has no rate of the last window: it shows the average of the whole run so far, and says so.
  const rate = averageRates(p, p.running, p);
  const endTick = p.untilS === undefined ? undefined : Math.round(p.untilS / props.dtS);
  // What the writer has left once the run is over: its own count while it reports one, else the last progress message's.
  const left = p.done ? p.backlogRecords : (props.writer?.backlogRecords ?? p.backlogRecords);
  const flushed = p.done && left === 0;
  return (
    <div className="panel hm" data-testid="headless-monitor" data-state={state}>
      <header className="hm-head mono">
        <span className="ps">{run.runId}</span>
        <span className="muted">{run.label}</span>
        <span className={`hm-state ${state}`} data-testid="hm-state" role="status">
          {state === "running" && `${GLYPH.running} running`}
          {state === "paused" && "❚❚ paused"}
          {state === "done" && (stoppedEarly ? "▲ stopped" : "✓ done")}
          {state === "live" && "◉ live view (no longer headless)"}
        </span>
        <span className="sp" />
        <span className="muted">lockstep · headless</span>
      </header>

      <section className="hm-sec" aria-label="Progress">
        <div className="hm-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(frac === undefined ? {} : { "aria-valuenow": Math.round(frac * 100) })} aria-label="Progress of the run" data-testid="hm-progress">
          <div className="hm-fill" style={{ width: `${(frac ?? 0) * 100}%` }} data-open={frac === undefined} />
          {snapshotMarks(p, props.dtS).map((m, i) => (
            <i key={`${i}-${m}`} className="hm-mark" style={{ left: `${m * 100}%` }} data-testid="hm-mark" title="a snapshot was taken here" />
          ))}
        </div>
        <div className="hm-line mono">
          <span data-testid="hm-ticks">
            tick {grouped(p.tick)}
            {endTick === undefined ? "" : ` / ${grouped(endTick)}`}
          </span>
          <span data-testid="hm-simtime">
            sim {formatDuration(p.simTimeS)}
            {p.untilS === undefined ? "" : ` / ${formatDuration(p.untilS)}`}
          </span>
          <span data-testid="hm-wall">wall {formatDuration(p.wallMs / 1000)}</span>
          <span data-testid="hm-eta" className={eta === undefined ? "muted" : ""}>
            {p.done ? "ended" : eta === undefined ? (p.untilS === undefined ? "no end condition" : "ETA —") : `ETA ${formatDuration(eta)}`}
          </span>
          <span className="muted" data-testid="hm-snapshots">
            {p.snapshotTicks.length} snapshot{p.snapshotTicks.length === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      <section className="hm-grid" aria-label="Speed and cost">
        <div className="hm-cell">
          <span className="lbl">Speed{rate.average ? " · average" : ""}</span>
          <b className="mono" data-testid="hm-speed">
            {speedLabel(rate.simSecondsPerSecond)}
          </b>
        </div>
        <div className="hm-cell">
          <span className="lbl">Ticks / s{rate.average ? " · average" : ""}</span>
          <b className="mono" data-testid="hm-tps">
            {rate.ticksPerSecond > 0 ? grouped(rate.ticksPerSecond) : "—"}
          </b>
        </div>
        <div className="hm-cell">
          <span className="lbl">Tick cost</span>
          <b className="mono" data-testid="hm-tickcost">
            {p.tickTimeMeanMs.toFixed(2)} <small>ms mean · {p.tickTimeP95Ms.toFixed(2)} p95</small>
          </b>
        </div>
        {p.done ? (
          <div className="hm-cell wide">
            <span className="lbl">{stoppedEarly ? "Stopped" : "Ended"}</span>
            <b data-testid="hm-ended" data-stopped={stoppedEarly}>
              {stoppedEarly ? "▲ stopped" : "✓ ended"} · tick {grouped(p.tick)} · {endCondition(p, stoppedEarly)}
            </b>
          </div>
        ) : (
          <div className="hm-cell wide">
            <span className="lbl">Waiting for</span>
            <b data-testid="hm-waiting" data-waiting={p.running ? p.waiting : "none"}>
              {waitingLabel(p.waiting, p.running, p.done)}
            </b>
          </div>
        )}
      </section>

      <section className="hm-sec" aria-label="Recording">
        <h4 className="sec">
          <b>Recording</b>
          <span className="rule" />
        </h4>
        <div className="hm-line mono">
          <span data-testid="hm-profile">
            profile {run.profileName ?? "—"}
            {run.profileHash === undefined ? "" : ` · ${run.profileHash}`}
          </span>
          <span data-testid="hm-written">{grouped(p.recordsHandedOver)} records handed over</span>
          <span data-testid="hm-volume" className={volume === undefined ? "muted" : ""}>
            {props.storedBytes === undefined ? "stored —" : `stored ${formatBytes(props.storedBytes)}`}
            {volume === undefined ? "" : ` · ≈ ${formatBytes(volume.perSimHourBytes)} per sim hour${volume.atEndBytes === undefined ? "" : ` · ≈ ${formatBytes(volume.atEndBytes)} at its end`}`}
          </span>
        </div>
        <div className="hm-line mono" data-testid="hm-writer" data-state={props.writer?.state ?? "ok"} data-flushed={flushed}>
          {p.done ? (
            // A finished run's writer is not "writing, keeping up": it is flushing what is left, or it has stored everything.
            flushed ? (
              <span>✓ flushed · all {grouped(p.recordsHandedOver)} records stored</span>
            ) : (
              <span className={props.writer && props.writer.state !== "ok" ? "warn" : ""}>
                {props.writer && props.writer.state !== "ok" ? "▲ " : ""}flushing · {grouped(left)} record{left === 1 ? "" : "s"} left
              </span>
            )
          ) : (
            <>
              <span className={props.writer && props.writer.state !== "ok" ? "warn" : ""}>
                {props.writer && props.writer.state !== "ok" ? "▲ " : ""}writer: {writerWords[props.writer?.state ?? "ok"]}
              </span>
              <span className="muted">
                backlog {grouped(p.backlogRecords)} records · {formatBytes(p.backlogBytes)}
              </span>
            </>
          )}
        </div>
      </section>

      {props.knowledge !== undefined && props.knowledge.band.points.length > 0 && (
        <section className="hm-sec" aria-label="Swarm knowledge" data-testid="hm-knowledge">
          <h4 className="sec">
            <b>Swarm knowledge</b>
            <span className="rule" />
          </h4>
          <p className="mono hm-knowledge-line" data-testid="hm-knowledge-line">
            {(() => {
              const k = knowledgeShown(props.knowledge.band, props.knowledge.endS);
              return k === undefined ? "–" : `${k.kind === "union" ? "swarm knows" : "agents know"} ${k.knownPct.toFixed(0)} %${k.kind === "union" ? "" : " avg"} · match ${k.matchPct.toFixed(0)} %`;
            })()}{" "}
            <span className="muted" title={knowledgeWords(props.knowledge.band, props.knowledge.endS)}>
              · observer data
            </span>
          </p>
          <div className="track kbt hm-band">
            <KnowledgeStrip band={props.knowledge.band} marks={props.knowledge.marks} runId={props.knowledge.runId} startS={0} scaleS={Math.max(props.knowledge.endS, 1)} atS={props.knowledge.endS} />
          </div>
        </section>
      )}

      <section className="hm-sec" aria-label="Metrics">
        <h4 className="sec">
          <b>Metrics</b>
          <span className="rule" />
        </h4>
        <div className="hm-sparks">
          {props.sparks.map((s) => {
            const last = s.points[s.points.length - 1];
            return (
              <figure key={s.name} className="hm-spark" data-testid={`hm-spark-${s.name}`} data-points={s.points.length}>
                <svg viewBox="0 0 160 48" preserveAspectRatio="none" width="100%" height="48" role="img" aria-label={`${s.title} over the run`}>
                  <polyline points={sparkPoints(s.points, 160, 48)} />
                </svg>
                <figcaption className="mono">
                  {s.title} <span className="muted">{last === undefined ? "no samples yet" : `${Math.round(last.v * 100) / 100} ${s.unit}`}</span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      </section>

      <section className="hm-stream" aria-label="Events">
        <h4 className="sec">
          <b>Events</b>
          <span className="rule" />
        </h4>
        <p className="muted hm-note" data-testid="hm-stream-note">
          {props.stream.sampled ? "▲ sampled: " : ""}a live subscription (at most 10 batches a second, at most 2,000 records a batch): {grouped(props.stream.totalShown)} of {grouped(props.stream.totalMatched)} matching records shown
          {props.stream.sampled ? "; the recording is not sampled" : ""}. Pose samples are left out.
        </p>
        <ul className="hm-rows mono" data-testid="hm-stream">
          {props.stream.rows.slice(-80).map((r) => {
            const style = KIND_STYLE[r.kind as keyof typeof KIND_STYLE];
            return (
              <li key={r.seq} data-seq={r.seq}>
                <span className="muted">{r.simTime.toFixed(2)} s</span> <span>{r.agentId ?? "run"}</span>{" "}
                <span className="tag" style={{ color: `var(--kind-${style?.family ?? "slate"})` }}>
                  [{style?.tag ?? r.kind.slice(0, 3).toUpperCase()}]
                </span>{" "}
                <span>{summary(r)}</span>
              </li>
            );
          })}
          {props.stream.rows.length === 0 && <li className="muted">nothing yet</li>}
        </ul>
      </section>

      <footer className="hm-acts" role="group" aria-label="Actions">
        {p.headless && !p.done && (p.running ? (
          <button type="button" className="btn" onClick={props.actions.pause} data-testid="hm-pause">
            ❚❚ Pause
          </button>
        ) : (
          <button type="button" className="btn pri" onClick={props.actions.play} data-testid="hm-play">
            {GLYPH.running} Resume
          </button>
        ))}
        {p.headless && !p.done && (
          <button type="button" className="btn" onClick={props.actions.stop} data-testid="hm-stop" data-tip="End the run now: its end snapshot is written and the run is kept">
            ■ Stop
          </button>
        )}
        <span className="sp" />
        <button type="button" className="btn" onClick={props.actions.openDebug} data-testid="hm-open-debug" data-tip="Replay what is saved so far in the Debug workspace">
          Open in Debug replay
        </button>
        <button
          type="button"
          className="btn pri"
          disabled={!p.done || props.actions.openAnalysis === undefined}
          onClick={props.actions.openAnalysis}
          data-testid="hm-open-analysis"
          data-tip={props.actions.openAnalysis === undefined ? "The Analysis workspace is not in this build yet" : p.done ? "Explore the finished run: trajectories, events, series" : "Available when the run is done"}
        >
          Open in Analysis
        </button>
      </footer>
    </div>
  );
}
