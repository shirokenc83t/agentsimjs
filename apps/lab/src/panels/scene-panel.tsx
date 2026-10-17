import "./panels.css";
import Button from "@mui/material/Button";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { PerformanceHud, SceneView, useUiContext, type GridViewMode, type HudStats, type SceneRenderer } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachRendererProbe } from "../probe.ts";
import { usePolled, useServices } from "../services.tsx";
import { HudBudgetRows } from "./hud-budget.tsx";
import { sandboxTarget, useSandboxTarget, useSandboxView } from "./sandbox-store.ts";
import { useSandboxOverlay } from "./use-sandbox-overlay.ts";
import { useStagesOverlay } from "./use-stages-overlay.ts";
import { useBeliefOverlay, type MapOverlay } from "./use-belief-overlay.ts";
import { useSensorOverlays } from "./use-sensor-overlays.ts";

interface PlanPayload {
  readonly op?: unknown;
  readonly status?: unknown;
  readonly waypoints?: unknown;
}

/** Latest found plan per agent, from the run's `compute` records (ADR-0004: every planning query is traced). */
export function latestPlans(records: readonly TraceRecord[]): Map<string, { seq: number; waypoints: [number, number][] }> {
  const out = new Map<string, { seq: number; waypoints: [number, number][] }>();
  for (const r of records) {
    if (r.kind !== "compute" || r.agentId === undefined) continue;
    const p = r.payload as PlanPayload;
    if (p.op !== "plan" || p.status !== "found" || !Array.isArray(p.waypoints)) continue;
    out.set(r.agentId, { seq: r.seq, waypoints: p.waypoints as [number, number][] });
  }
  return out;
}

/**
 * Scene workspace main panel: the grid atlas, agents with labels, zones, planned (dashed) vs executed
 * (solid) paths, picking into the shared UI context (ADR-0016), view modes and the Performance HUD.
 */
export function ScenePanel() {
  const { sim } = useServices();
  const [renderer, setRenderer] = useState<SceneRenderer | undefined>(undefined);
  const [interpolation, setInterpolation] = useState(true);
  const [mode, setMode] = useState<GridViewMode>("occupancy");
  const [overlay, setOverlay] = useState<MapOverlay>("truth");
  const [showRays, setShowRays] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [showStages, setShowStages] = useState(false);
  // Snapshot at ≤ 10 Hz: entity table, run and grid (agent colours are derived from IDs once per agent).
  const snap = usePolled(useCallback(() => sim.snapshot(), [sim]), 100);
  const selection = useUiContext((s) => s.selection);
  const selectedAgent = selection?.kind === "agent" ? selection.id : undefined;
  // "Send to" mode (ADR-0015 researcher command): the next ground click becomes the selected agent's target.
  const [sendFor, setSendFor] = useState<string | undefined>(undefined);
  const sendRef = useRef<string | undefined>(undefined);
  sendRef.current = sendFor;

  const onRenderer = useCallback(
    (r: SceneRenderer | undefined) => {
      setRenderer(r);
      attachRendererProbe(r);
      if (r) {
        r.onPick = (p) => {
          // The Strategy test's target gesture (a researcher tool): the next ground click is its target, never a command.
          if (sandboxTarget.get().picking && p.kind === "cell") {
            sandboxTarget.setTarget(p.xM, p.yM);
            return;
          }
          const agentId = sendRef.current;
          if (agentId !== undefined && p.kind === "cell") {
            sim.command(agentId, "goTo", { xM: p.xM, yM: p.yM });
            setSendFor(undefined);
            return;
          }
          useUiContext.getState().select(p.kind === "agent" ? { kind: "agent", id: p.id } : { kind: "cell", id: `${p.i},${p.j}` });
        };
      }
    },
    [sim],
  );

  // G toggles "send to" for the selected agent; Escape cancels. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        setSendFor(undefined);
        sandboxTarget.cancelPicking();
      }
      else if ((e.key === "g" || e.key === "G") && !e.ctrlKey && !e.metaKey && selectedAgent) setSendFor((cur) => (cur ? undefined : selectedAgent));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedAgent]);

  // A selection change leaves "send to" mode (the target would go to another agent).
  useEffect(() => {
    if (sendFor !== undefined && sendFor !== selectedAgent) setSendFor(undefined);
  }, [selectedAgent, sendFor]);

  useEffect(() => renderer?.setGrid(snap.grid), [renderer, snap.grid]);
  // The belief overlay (F2): the selected agent's own map, streamed only while it is shown. `ideal` agents have none.
  const ideal = selectedAgent !== undefined && (snap.run?.idealAgents ?? []).includes(selectedAgent);
  const chunksX = snap.grid ? Math.ceil(snap.grid.dims.sizeX / snap.grid.dims.chunkSize) : 0;
  useBeliefOverlay(sim, renderer, overlay, selectedAgent, !ideal, snap.run?.runId, chunksX);
  useSensorOverlays(sim, renderer, showRays, showTopology, selectedAgent, snap.run?.runId);
  useStagesOverlay(sim, renderer, showStages, selectedAgent);
  useSandboxOverlay(renderer, selectedAgent);
  const sandbox = useSandboxView();
  const picking = useSandboxTarget().picking;
  useEffect(() => renderer?.setViewMode(mode), [renderer, mode, snap.grid]);

  useEffect(() => {
    const kinds = snap.run?.agents;
    const airborne = snap.entityIds.map((id) => kinds?.find((a) => a.id === id)?.kind === "uav");
    renderer?.setEntityIds(snap.entityIds, airborne);
  }, [renderer, snap.entityIds, snap.run]);

  useEffect(() => renderer?.setSelection(selection?.kind === "agent" ? selection.id : undefined), [renderer, selection, snap.entityIds]);

  // Planned paths: pushed to the renderer only when an agent's latest plan changes.
  useEffect(() => {
    if (!renderer) return;
    const shown = new Map<string, number>();
    const refresh = () => {
      for (const [agentId, plan] of latestPlans(sim.records())) {
        if (shown.get(agentId) === plan.seq) continue;
        shown.set(agentId, plan.seq);
        renderer.setPlannedPath(agentId, plan.waypoints);
      }
    };
    refresh();
    return sim.onRecords(refresh);
  }, [renderer, sim, snap.grid]);

  // Executed paths: points recorded by the worker from tick states; appended as they arrive.
  useEffect(() => {
    if (!renderer) return;
    const refresh = () => {
      for (const id of sim.snapshot().entityIds) renderer.setExecutedPath(id, sim.executedPath(id));
    };
    refresh();
    return sim.onTrail(refresh);
  }, [renderer, sim, snap.grid, snap.entityIds]);

  const getStats = useCallback((): HudStats => {
    const r = renderer;
    const s = sim.snapshot();
    const meanInterval = r?.frameIntervalMs.mean() ?? 0;
    return {
      fps: meanInterval > 0 ? 1000 / meanInterval : 0,
      frameWorkMeanMs: r?.frameWorkMs.mean() ?? 0,
      frameWorkP95Ms: r?.frameWorkMs.percentile(0.95) ?? 0,
      frameIntervalP95Ms: r?.frameIntervalMs.percentile(0.95) ?? 0,
      simTickRateHz: s.tickRateHz,
      simTicksPerSecond: s.ticksPerSecond,
      simTickP95Ms: s.tickTimeP95Ms,
      stateLatencyP95Ms: sim.stateLatencyMs.percentile(0.95),
      interpolationIntervalMs: sim.interpolator.intervalEstimateMs,
      entities: sim.interpolator.entityCount,
    };
  }, [sim, renderer]);

  return (
    <SceneView interpolator={sim.interpolator} onRenderer={onRenderer}>
      {snap.grid && (
        <div className={`scene-overlay${sendFor ? " sending" : ""}`} data-testid="scene-overlay">
          <div className="row">
            <Button
              size="small"
              variant={sendFor ? "contained" : "outlined"}
              color="inherit"
              disabled={!selectedAgent}
              onClick={() => setSendFor(sendFor ? undefined : selectedAgent)}
              aria-pressed={sendFor !== undefined}
              data-testid="send-to"
              title="Send the selected agent to a point (G); Esc cancels"
            >
              {sendFor ? `Click a target for ${sendFor} · Esc` : selectedAgent ? `Send ${selectedAgent} to… (G)` : "Send to… (select an agent)"}
            </Button>
          </div>
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, m: GridViewMode | null) => m && setMode(m)} aria-label="Grid view">
            <ToggleButton value="occupancy" data-testid="view-occupancy">
              occupancy
            </ToggleButton>
            <ToggleButton value="terrain" data-testid="view-terrain">
              terrain
            </ToggleButton>
            <ToggleButton value="height" data-testid="view-height">
              height
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup size="small" exclusive value={overlay} onChange={(_e, v: MapOverlay | null) => v && setOverlay(v)} aria-label="Map overlay">
            <ToggleButton value="truth" data-testid="overlay-truth" title="The ground-truth map">
              truth
            </ToggleButton>
            <ToggleButton value="belief" data-testid="overlay-belief" title="The selected agent's own map">
              belief
            </ToggleButton>
            <ToggleButton value="difference" data-testid="overlay-difference" title="Researcher view: the agent's map against the ground truth">
              ◆ difference
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup size="small" value={[...(showRays ? ["rays"] : []), ...(showTopology ? ["topology"] : [])]} onChange={(_e, v: string[]) => { setShowRays(v.includes("rays")); setShowTopology(v.includes("topology")); }} aria-label="Sensor and topology overlays">
            <ToggleButton value="rays" data-testid="overlay-rays" title="The selected agent's lidar rays (decimated)">
              ⌁ rays
            </ToggleButton>
            <ToggleButton value="topology" data-testid="overlay-frontiers" title="The selected agent's regions and frontier groups">
              ◌ frontiers
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup size="small" value={showStages ? ["stages"] : []} onChange={(_e, v: string[]) => setShowStages(v.includes("stages"))} aria-label="Strategy stages overlay">
            <ToggleButton value="stages" data-testid="overlay-stages" title="The stages of the selected planning query: coarse path, legs and joints">
              ⑂ stages
            </ToggleButton>
          </ToggleButtonGroup>
          {picking && <p className="muted" data-testid="scene-sandbox-picking">Click a target for the Strategy test · Esc</p>}
          {(showRays || showTopology) && !selectedAgent && <p className="muted">Select an agent to see its rays and frontiers.</p>}
          {overlay !== "truth" && !selectedAgent && <p className="muted">Select an agent to see its map.</p>}
          {overlay !== "truth" && ideal && <p className="muted" data-testid="overlay-ideal">◆ ideal: this agent plans on the ground truth, it has no map of its own.</p>}
          {overlay === "difference" && (
            <p className="researcher-banner" role="note" data-testid="scene-researcher-marker">
              ◆ Researcher view — not visible to the mind
            </p>
          )}
          {overlay !== "truth" && (
            <dl className="kv legend" data-testid="overlay-legend">
              <dt>■ dark</dt>
              <dd>unknown to the agent</dd>
              {overlay === "difference" && (
                <>
                  <dt>╱ hatched</dt>
                  <dd>believed occupied, actually free</dd>
                  <dt>╳ cross-hatched</dt>
                  <dd>believed free, actually blocked</dd>
                </>
              )}
            </dl>
          )}
          {(showRays || showTopology) && (
            <dl className="kv legend" data-testid="sensor-legend">
              {showRays && (
                <>
                  <dt>─ accent</dt>
                  <dd>lidar ray that hit an obstacle</dd>
                  <dt>─ grey</dt>
                  <dd>lidar ray that reached its range</dd>
                </>
              )}
              {showTopology && (
                <>
                  <dt>□ outline</dt>
                  <dd>region of the agent's topological layer</dd>
                  <dt>● amber</dt>
                  <dd>frontier group: known free next to unknown</dd>
                  <dt>● red</dt>
                  <dd>frontier group marked unreachable</dd>
                </>
              )}
            </dl>
          )}
          {(showStages || sandbox) && (
            <dl className="kv legend" data-testid="stages-legend">
              {showStages && (
                <>
                  <dt>╌╌ dashed</dt>
                  <dd>coarse path of a refine</dd>
                  <dt>── solid, two tones</dt>
                  <dd>the legs of a plan, alternating</dd>
                  <dt>● ① ②</dt>
                  <dd>numbered joint: where one leg ends and the next begins</dd>
                </>
              )}
              {sandbox && (
                <>
                  <dt>── orange</dt>
                  <dd data-testid="sandbox-legend">Strategy test result (not part of the run)</dd>
                </>
              )}
            </dl>
          )}
          <dl className="kv legend">
            <dt>╌╌ dashed</dt>
            <dd>planned path</dd>
            <dt>── solid</dt>
            <dd>executed path</dd>
            {mode === "height" && (
              <>
                <dt>▨ hatched</dt>
                <dd>occupied, unknown height</dd>
              </>
            )}
          </dl>
        </div>
      )}
      <PerformanceHud
        extra={<HudBudgetRows sim={sim} runId={snap.run?.runId} />}
        getStats={getStats}
        interpolation={interpolation}
        onInterpolationChange={(on) => {
          setInterpolation(on);
          sim.interpolator.setEnabled(on);
        }}
      />
    </SceneView>
  );
}
