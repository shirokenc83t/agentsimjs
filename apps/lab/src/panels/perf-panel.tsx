import "./panels.css";
import { PerformanceHud, type HudStats } from "@agentsim/ui";
import { useCallback, useState } from "react";
import { usePolled, useSource } from "../services.tsx";
import { getFrameStats } from "../shell/frame-stats.ts";
import { HudBudgetRows } from "./hud-budget.tsx";

/**
 * The Performance HUD as a floating window (ADR-0042 §5; UI-SPEC §4): in every workspace, collapsed to its title bar until it is opened. The sim figures are the
 * source's; the render figures are published by the Scene while one is on screen (the window reads zero without it).
 */
export function PerfPanel() {
  const source = useSource();
  const [interpolation, setInterpolation] = useState(true);
  const runId = usePolled(useCallback(() => source.snapshot().run?.runId, [source]), 500);
  const getStats = useCallback((): HudStats => {
    const f = getFrameStats();
    const s = source.stats();
    return {
      fps: f?.fps ?? 0,
      frameWorkMeanMs: f?.workMeanMs ?? 0,
      frameWorkP95Ms: f?.workP95Ms ?? 0,
      frameIntervalP95Ms: f?.intervalP95Ms ?? 0,
      simTickRateHz: s.simTickRateHz,
      simTicksPerSecond: s.simTicksPerSecond,
      simTickP95Ms: s.simTickP95Ms,
      stateLatencyP95Ms: s.stateLatencyP95Ms,
      interpolationIntervalMs: s.interpolationIntervalMs,
      entities: s.entities,
    };
  }, [source]);
  return (
    <div className="perf-panel">
      <PerformanceHud
        extra={<HudBudgetRows source={source} runId={runId} />}
        getStats={getStats}
        interpolation={interpolation}
        onInterpolationChange={(on) => {
          setInterpolation(on);
          source.poses.setInterpolation(on);
        }}
      />
    </div>
  );
}
