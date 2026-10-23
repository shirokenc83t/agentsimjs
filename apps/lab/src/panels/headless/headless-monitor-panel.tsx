import "../panels.css";
import { useCallback, useId, useMemo } from "react";
import { useSeries } from "../inspector/use-series.ts";
import { useAppActions, useCurrentRun, usePolled, useServices } from "../../services.tsx";
import { WORKSPACES } from "../../workspaces/presets.ts";
import { HeadlessMonitorView, type Spark } from "./headless-monitor-view.tsx";
import { useSampledStream, useStoredBytes } from "./use-monitor-data.ts";

/** The metrics the monitor draws: the tick's wall cost, what the planner spends and the writer's backlog. */
const SPARKS = [
  { name: "sim.tickMs", title: "tick cost", unit: "ms" },
  { name: "sim.planExpansions", title: "planner expansions", unit: "per tick" },
  { name: "storage.backlogRecords", title: "writer backlog", unit: "records" },
] as const;

/**
 * The headless run monitor of the Experiments workspace (ADR-0029, ADR-0035 section 7): it follows the loaded run if it is headless, through the worker's progress stream, a
 * live subscription to the run's records and its metrics, and what storage reports. A run that is not headless is not shown here (it has a live view).
 */
export function HeadlessMonitorPanel() {
  const { sim, storage } = useServices();
  const { run } = useCurrentRun();
  const { openReplay, openWorkspace } = useAppActions();
  const snap = usePolled(useCallback(() => sim.snapshot(), [sim]), 200);
  // The client keeps the latest progress, so a monitor opened late (the workspace was elsewhere) shows the run as it is.
  const progress = snap.progress;
  const runId = snap.run?.runId;
  const mine = progress !== undefined && progress.runId === runId ? progress : undefined;
  const base = useId().replace(/[^A-Za-z0-9]/g, "");
  const tail = mine !== undefined && !mine.done;
  const stream = useSampledStream(storage, mine === undefined ? undefined : runId, `hm-${base}-events`);
  const stored = useStoredBytes(storage, mine === undefined ? undefined : runId, tail);
  // One series per metric, each its own live subscription (a metric filter), tailing while the run is not done.
  const tick = useSeries({ storage, runId: mine === undefined ? undefined : runId, filter: `metric:${SPARKS[0].name} source:world/sim`, tail, viewId: `hm-${base}-m0` });
  const plan = useSeries({ storage, runId: mine === undefined ? undefined : runId, filter: `metric:${SPARKS[1].name} source:world/sim`, tail, viewId: `hm-${base}-m1` });
  const backlog = useSeries({ storage, runId: mine === undefined ? undefined : runId, filter: `metric:${SPARKS[2].name} source:world/storage`, tail, viewId: `hm-${base}-m2` });
  const sparks: Spark[] = useMemo(
    () => [tick, plan, backlog].map((s, i) => ({ name: (SPARKS[i] as (typeof SPARKS)[number]).name, title: (SPARKS[i] as (typeof SPARKS)[number]).title, unit: (SPARKS[i] as (typeof SPARKS)[number]).unit, points: s.lines[0]?.points ?? [] })),
    [tick, plan, backlog],
  );
  const header = run?.header;
  const profile = header?.recordingProfile as { name?: string } | undefined;
  const analysis = WORKSPACES.some((w) => (w.id as string) === "analysis");
  return (
    <HeadlessMonitorView
      progress={mine}
      dtS={snap.run?.dtS ?? 0.1}
      run={mine === undefined || header === undefined ? undefined : { runId: header.runId, label: header.label, profileName: profile?.name, profileHash: header.recordingProfileHash }}
      storedBytes={stored}
      stream={stream}
      sparks={sparks}
      writer={snap.recording === undefined || snap.recording.runId !== runId ? undefined : { state: snap.recording.state, backlogRecords: snap.recording.backlogRecords }}
      actions={{
        pause: () => sim.pause(),
        play: () => sim.play(),
        stop: () => sim.stop(),
        openDebug: () => {
          if (runId === undefined) return;
          openReplay(runId);
          openWorkspace("debug");
        },
        openAnalysis: analysis
          ? () => {
              if (runId === undefined) return;
              openReplay(runId);
              openWorkspace("analysis" as never);
            }
          : undefined,
      }}
    />
  );
}
