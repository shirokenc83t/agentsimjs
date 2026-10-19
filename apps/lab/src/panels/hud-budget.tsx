import { useSimStream } from "./use-sim-stream.ts";
import type { RunSource } from "../sim/run-source.ts";

const ms = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(1));

/**
 * The sensing and planning budget rows of the HUD (UI-SPEC §4, ADR-0013): how much of each tick the sensors and the
 * planner use. They come from the worker's `budget` stream (≈ 3 Hz, wall-time diagnostics that never enter a trace or a
 * hash); the code lives in the lazily loaded Scene panel, not in the shell.
 */
export function HudBudgetRows(props: { source: RunSource; runId: string | undefined }) {
  const { source, runId } = props;
  const b = useSimStream(source, "budget", (m) => m.runId === runId, [runId]);
  return (
    <>
      <dt>sensing</dt>
      <dd data-testid="hud-sensing">{b ? `${ms(b.sensingMsMean)} ms · p95 ${ms(b.sensingMsP95)} ms` : "—"}</dd>
      <dt>rays / tick</dt>
      <dd data-testid="hud-rays">{b ? `${Math.round(b.raysPerTick)} (${Math.round(b.lidarRaysPerTick)} lidar)` : "—"}</dd>
      <dt>planning</dt>
      <dd data-testid="hud-planning">{b ? `${Math.round(b.planningExpansionsPerTick)} of ${Math.round(b.planningBudgetPerTick)} exp/tick · ${b.planningQueries} queries` : "—"}</dd>
    </>
  );
}
