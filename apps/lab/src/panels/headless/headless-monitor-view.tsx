import "../panels.css";
import { formatBytes, GLYPH, KIND_STYLE } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { summary } from "../debug/log-rows.ts";
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
  /** The storage writer's state as the worker reports it (`ok`, or why the run waits). */
  readonly writer: { readonly state: "ok" | "storage_backpressure" | "storage_quota"; readonly backlogRecords: number } | undefined;
  readonly actions: { pause(): void; play(): void; stop(): void; openDebug(): void; openAnalysis: (() => void) | undefined };
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
        <p className="muted hm-empty" data-testid="hm-empty">
          No headless run. “Run headless” (the player, the run popover, Author, or the palette) runs the scenario again with no live view, as fast as lockstep allows, always recorded.
        </p>
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
          <span className="lbl">SPEED{rate.average ? " · AVERAGE" : ""}</span>
          <b className="mono" data-testid="hm-speed">
            {speedLabel(rate.simSecondsPerSecond)}
          </b>
        </div>
        <div className="hm-cell">
          <span className="lbl">TICKS / S{rate.average ? " · AVERAGE" : ""}</span>
          <b className="mono" data-testid="hm-tps">
            {rate.ticksPerSecond > 0 ? grouped(rate.ticksPerSecond) : "—"}
          </b>
        </div>
        <div className="hm-cell">
          <span className="lbl">TICK COST</span>
          <b className="mono" data-testid="hm-tickcost">
            {p.tickTimeMeanMs.toFixed(2)} <small>ms mean · {p.tickTimeP95Ms.toFixed(2)} p95</small>
          </b>
        </div>
        <div className="hm-cell wide">
          <span className="lbl">WAITING FOR</span>
          <b data-testid="hm-waiting" data-waiting={p.running ? p.waiting : "none"}>
            {waitingLabel(p.waiting, p.running, p.done)}
          </b>
        </div>
      </section>

      <section className="hm-sec" aria-label="Recording">
        <h4 className="sec">
          <b>RECORDING</b>
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
        <div className="hm-line mono" data-testid="hm-writer" data-state={props.writer?.state ?? "ok"}>
          <span className={props.writer && props.writer.state !== "ok" ? "warn" : ""}>
            {props.writer && props.writer.state !== "ok" ? "▲ " : ""}writer: {writerWords[props.writer?.state ?? "ok"]}
          </span>
          <span className="muted">
            backlog {grouped(p.backlogRecords)} records · {formatBytes(p.backlogBytes)}
          </span>
        </div>
      </section>

      <section className="hm-sec" aria-label="Metrics">
        <h4 className="sec">
          <b>METRICS</b>
          <span className="rule" />
        </h4>
        <div className="hm-sparks">
          {props.sparks.map((s) => {
            const last = s.points[s.points.length - 1];
            return (
              <figure key={s.name} className="hm-spark" data-testid={`hm-spark-${s.name}`} data-points={s.points.length}>
                <svg viewBox="0 0 160 28" width="160" height="28" role="img" aria-label={`${s.title} over the run`}>
                  <polyline points={sparkPoints(s.points, 160, 28)} />
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
          <b>EVENTS</b>
          <span className="rule" />
        </h4>
        <p className="muted hm-note" data-testid="hm-stream-note">
          {props.stream.sampled ? "▲ sampled: " : ""}a live subscription (at most 10 batches a second, at most 2,000 records a batch): {grouped(props.stream.totalShown)} of {grouped(props.stream.totalMatched)} matching records shown
          {props.stream.sampled ? "; the recording is not sampled" : ""}. Pose samples are left out.
        </p>
        <ul className="hm-rows mono" data-testid="hm-stream">
          {props.stream.rows.slice(-30).map((r) => {
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
