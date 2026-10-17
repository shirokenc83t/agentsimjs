import { useEffect, useState, type ReactNode } from "react";
import { formatMs } from "../format.ts";

export interface HudStats {
  readonly fps: number;
  readonly frameWorkMeanMs: number;
  readonly frameWorkP95Ms: number;
  readonly frameIntervalP95Ms: number;
  readonly simTickRateHz: number;
  readonly simTicksPerSecond: number;
  readonly simTickP95Ms: number;
  readonly stateLatencyP95Ms: number;
  readonly interpolationIntervalMs: number;
  readonly entities: number;
}

/** Performance HUD (UI-SPEC §4). Polled at 4 Hz — panels never update faster than 10 Hz (ADR-0016). */
export function PerformanceHud(props: {
  getStats: () => HudStats;
  interpolation: boolean;
  onInterpolationChange: (enabled: boolean) => void;
  refreshMs?: number;
  /** More rows, from the panel that owns the data (the sensing and planning budget): the HUD itself stays small. */
  extra?: ReactNode;
}) {
  const { getStats, refreshMs = 250 } = props;
  const [s, setS] = useState<HudStats>(getStats);
  useEffect(() => {
    const t = setInterval(() => setS(getStats()), Math.max(100, refreshMs));
    return () => clearInterval(t);
  }, [getStats, refreshMs]);

  return (
    <div className="hud" data-testid="perf-hud" aria-label="Performance HUD">
      <dl className="kv">
        <dt>render</dt>
        <dd data-testid="hud-fps">{s.fps.toFixed(0)} fps</dd>
        <dt>frame work</dt>
        <dd>
          {formatMs(s.frameWorkMeanMs)} · p95 {formatMs(s.frameWorkP95Ms)}
        </dd>
        <dt>frame p95</dt>
        <dd>{formatMs(s.frameIntervalP95Ms)}</dd>
        <dt>sim tick</dt>
        <dd data-testid="hud-tick-rate">
          {s.simTicksPerSecond.toFixed(1)}/s (target {s.simTickRateHz} Hz)
        </dd>
        <dt>tick p95</dt>
        <dd>{formatMs(s.simTickP95Ms)}</dd>
        <dt>state msg p95</dt>
        <dd>{formatMs(s.stateLatencyP95Ms)}</dd>
        <dt>interp. Δ</dt>
        <dd>{formatMs(s.interpolationIntervalMs)}</dd>
        <dt>entities</dt>
        <dd>{s.entities}</dd>
      </dl>
      <label>
        <input
          type="checkbox"
          data-testid="hud-interpolation"
          checked={props.interpolation}
          onChange={(e) => props.onInterpolationChange(e.target.checked)}
        />
        interpolation
      </label>
      {/* Below the checkbox, so rows added by the panel never move it (tests and users click the scene around it). */}
      {props.extra && <dl className="kv">{props.extra}</dl>}
    </div>
  );
}
