import { publishFrameStats } from "../shell/frame-stats.ts";
import "./panels.css";
import Button from "@mui/material/Button";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { identityOf, SceneView, shortLabel, useUiContext, type AgentDecor, type GridViewMode, type MapPin, type SceneRenderer } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachRendererProbe } from "../probe.ts";
import { agentFacts, commandHint } from "../commands.ts";
import { usePolled, useSource } from "../services.tsx";
import { Scene2dView } from "./scene-2d.tsx";
import { actionLabel } from "./agent-views.ts";
import { useAttention } from "./attention-store.ts";
import { sandboxTarget, useSandboxTarget, useSandboxView } from "./sandbox-store.ts";
import { publishScene } from "./scene-handle.ts";
import { publishSceneView } from "./scene-view-store.ts";
import { useAgentViews } from "./use-agent-views.ts";
import { useSandboxOverlay } from "./use-sandbox-overlay.ts";
import { useExploreOverlay } from "./use-explore-overlay.ts";
import { useStagesOverlay } from "./use-stages-overlay.ts";
import { useBeliefOverlay, type MapOverlay } from "./use-belief-overlay.ts";
import { useSensorOverlays } from "./use-sensor-overlays.ts";

/**
 * Scene workspace main panel: the grid atlas, agents with labels, zones, planned (dashed) vs executed
 * (solid) paths, picking into the shared UI context (ADR-0016), view modes and the Performance HUD.
 */
export function ScenePanel() {
  const source = useSource();
  const [renderer, setRenderer] = useState<SceneRenderer | undefined>(undefined);
  const [mode, setMode] = useState<GridViewMode>("occupancy");
  const [overlay, setOverlay] = useState<MapOverlay>("truth");
  // The map as the 3D view (perspective, the renderer) or from above (2D, the shared top-down map component).
  const [view, setView] = useState<"3d" | "2d">("3d");
  const [showRays, setShowRays] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [showStages, setShowStages] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  // Snapshot at ≤ 10 Hz: entity table, run and grid (agent colours are derived from IDs once per agent).
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const selection = useUiContext((s) => s.selection);
  const selectedAgent = selection?.kind === "agent" ? selection.id : undefined;
  // Features with no recorded source are off in replay, each with its reason (undefined while the source has them).
  const noCommands = source.unavailable("commands");
  // Sending an agent somewhere is a goTo: it asks the same availability check as the Inspector's buttons (a grounded UAV needs to take off first).
  const sendHint = selectedAgent === undefined ? undefined : commandHint("goTo", "Send to", agentFacts(snap.run, snap.agentStatus, snap.entityIds, selectedAgent));
  const noRays = source.unavailable("rays");
  const noTopology = source.unavailable("topology");
  // "Send to" mode (ADR-0015 researcher command): the next ground click becomes the selected agent's target.
  const [sendFor, setSendFor] = useState<string | undefined>(undefined);
  const sendRef = useRef<string | undefined>(undefined);
  sendRef.current = sendFor;

  const onRenderer = useCallback(
    (r: SceneRenderer | undefined) => {
      setRenderer(r);
      publishScene(r);
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
            source.command(agentId, "goTo", { xM: p.xM, yM: p.yM });
            setSendFor(undefined);
            return;
          }
          useUiContext.getState().select(p.kind === "agent" ? { kind: "agent", id: p.id } : { kind: "cell", id: `${p.i},${p.j}` });
        };
      }
    },
    [source],
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
  useBeliefOverlay(source, renderer, overlay, selectedAgent, !ideal, snap.run?.runId, chunksX);
  useSensorOverlays(source, renderer, showRays, showTopology, selectedAgent, snap.run?.runId);
  useStagesOverlay(source, renderer, showStages, selectedAgent);
  useExploreOverlay(source, renderer, showExplore, selectedAgent, snap.grid, snap.simTimeS);
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
      for (const [agentId, plan] of source.plannedPaths()) {
        if (shown.get(agentId) === plan.seq) continue;
        shown.set(agentId, plan.seq);
        renderer.setPlannedPath(agentId, plan.waypoints);
      }
    };
    refresh();
    return source.onRecords(refresh);
  }, [renderer, source, snap.grid]);

  // Executed paths: points recorded by the worker from tick states; appended as they arrive.
  useEffect(() => {
    if (!renderer) return;
    const refresh = () => {
      for (const id of source.snapshot().entityIds) renderer.setExecutedPath(id, source.executedPath(id));
    };
    refresh();
    return source.onTrail(refresh);
  }, [renderer, source, snap.grid, snap.entityIds]);

  // The status bar's frame time: published from here, where the renderer and its frame timers are.
  useEffect(() => {
    if (!renderer) return;
    const publish = () => {
      const meanInterval = renderer.frameIntervalMs.mean();
      publishFrameStats({
        fps: meanInterval > 0 ? 1000 / meanInterval : 0,
        workMeanMs: renderer.frameWorkMs.mean(),
        workP95Ms: renderer.frameWorkMs.percentile(0.95),
        intervalP95Ms: renderer.frameIntervalMs.percentile(0.95),
      });
    };
    publish();
    const t = setInterval(publish, 500);
    return () => {
      clearInterval(t);
      publishFrameStats(undefined);
    };
  }, [renderer]);

  // Identity, short label and attention badge of every agent, and the pins of collisions, pushed to the renderer when they change (at most 10 Hz).
  const attn = useAttention(source);
  const [labelMode, setLabelMode] = useState<"short" | "full">("short");
  const decorKey = snap.entityIds
    .map((id) => {
      const c = attn.byAgent.get(id)?.conditions[0];
      return `${id}:${c ? `${c.level}/${c.glyph}/${c.label}` : ""}`;
    })
    .join("|");
  const pinsKey = snap.entityIds.flatMap((id) => (attn.byAgent.get(id)?.conditions ?? []).filter((c) => c.at).map((c) => `${id}@${c.at?.xM},${c.at?.yM}`)).join("|");
  const attnRef = useRef(attn);
  attnRef.current = attn;
  const decor = useMemo<AgentDecor[]>(
    () =>
      snap.entityIds.map((id, i) => {
        const idn = identityOf(i);
        const c = attnRef.current.byAgent.get(id)?.conditions[0];
        return { id, short: shortLabel(id), colorIndex: idn.colorIndex, style: idn.style, badge: c ? { level: c.level, glyph: c.glyph, text: c.label } : undefined };
      }),
    [snap.entityIds, decorKey],
  );
  useEffect(() => renderer?.setAgentDecor(decor), [renderer, decor]);
  useEffect(() => {
    const pins: MapPin[] = snap.entityIds.flatMap((id) => (attnRef.current.byAgent.get(id)?.conditions ?? []).filter((c) => c.at).map((c) => ({ id, xM: c.at?.xM ?? 0, yM: c.at?.yM ?? 0 })));
    renderer?.setPins(pins);
  }, [renderer, pinsKey, snap.entityIds]);
  useEffect(() => renderer?.setLabelMode(labelMode), [renderer, labelMode]);

  // The tooltip of the agent under the pointer: the whole ID, its identity and what it is doing.
  const views = useAgentViews(source);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    if (!renderer) return;
    renderer.onHover = (id, x, y) => setHover(id === undefined ? undefined : { id, x, y });
    return () => {
      renderer.onHover = undefined;
    };
  }, [renderer]);
  const hoverAgent = hover ? snap.run?.agents.find((a) => a.id === hover.id) : undefined;
  const hoverCondition = hover ? attn.byAgent.get(hover.id)?.conditions[0] : undefined;

  // What the Legend window explains.
  useEffect(() => {
    publishSceneView({ mode, overlay, rays: showRays, topology: showTopology, stages: showStages, explore: showExplore, sandbox: !!sandbox });
  }, [mode, overlay, showRays, showTopology, showStages, showExplore, sandbox]);
  useEffect(() => () => publishScene(undefined), []);

  return (
    <div className="scene-col">
      {snap.grid && (
        <>
          <div className="scene-toolbar" role="toolbar" aria-label="Scene controls" data-testid="scene-toolbar">
            <ToggleButtonGroup size="small" exclusive value={view} onChange={(_e, v: "3d" | "2d" | null) => v && setView(v)} aria-label="Map view">
              <ToggleButton value="2d" data-testid="map-view-2d" title="From above: where the agents are and have been">
                MAP 2D
              </ToggleButton>
              <ToggleButton value="3d" data-testid="map-view-3d" title="The 3D scene">
                3D
              </ToggleButton>
            </ToggleButtonGroup>
            {view === "3d" && (<>
            <ToggleButtonGroup size="small" exclusive value={overlay} onChange={(_e, v: MapOverlay | null) => v && setOverlay(v)} aria-label="Map overlay">
              <ToggleButton value="truth" data-testid="overlay-truth" title="The ground-truth map">
                truth
              </ToggleButton>
              <ToggleButton value="belief" data-testid="overlay-belief" title="The selected agent's own map">
                ● belief
              </ToggleButton>
              <ToggleButton value="difference" data-testid="overlay-difference" title="Researcher view: the agent's map against the ground truth">
                ◆ difference
              </ToggleButton>
            </ToggleButtonGroup>
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
            <ToggleButtonGroup size="small" value={[...(showRays ? ["rays"] : []), ...(showTopology ? ["topology"] : [])]} onChange={(_e, v: string[]) => { setShowRays(v.includes("rays")); setShowTopology(v.includes("topology")); }} aria-label="Sensor and topology overlays">
              <ToggleButton value="rays" data-testid="overlay-rays" disabled={noRays !== undefined} title={noRays ?? "The selected agent's lidar rays (decimated)"}>
                ⌁ rays
              </ToggleButton>
              <ToggleButton value="topology" data-testid="overlay-frontiers" disabled={noTopology !== undefined} title={noTopology ?? "The selected agent's regions and frontier groups"}>
                ◌ frontiers
              </ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup size="small" value={showStages ? ["stages"] : []} onChange={(_e, v: string[]) => setShowStages(v.includes("stages"))} aria-label="Strategy stages overlay">
              <ToggleButton value="stages" data-testid="overlay-stages" title="The stages of the selected planning query: coarse path, legs and joints">
                ⑂ stages
              </ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup size="small" value={showExplore ? ["explore"] : []} onChange={(_e, v: string[]) => setShowExplore(v.includes("explore"))} aria-label="Exploration overlay">
              <ToggleButton value="explore" data-testid="overlay-explore" title="The selected agent's exploration: the area of its iteration, the targets set aside for it and the ones marked unreachable">
                ◎ explore
              </ToggleButton>
            </ToggleButtonGroup>
            </>)}
            <ToggleButtonGroup size="small" exclusive value={labelMode} onChange={(_e, m: "short" | "full" | null) => m && setLabelMode(m)} aria-label="Labels">
              <ToggleButton value="short" data-testid="labels-short" title="Short labels: g07 for ugv-007">
                # g07
              </ToggleButton>
              <ToggleButton value="full" data-testid="labels-full" title="Whole IDs">
                # ugv-007
              </ToggleButton>
            </ToggleButtonGroup>
            {view === "3d" && (<Button
              size="small"
              variant="outlined"
              className={sendFor ? "act-armed" : undefined}
              color="inherit"
              disabled={!selectedAgent || noCommands !== undefined || sendHint !== undefined}
              onClick={() => setSendFor(sendFor ? undefined : selectedAgent)}
              aria-pressed={sendFor !== undefined}
              data-testid="send-to"
              title={noCommands ?? sendHint ?? "Send the selected agent to a point (G); Esc cancels"}
            >
              {sendFor ? `◎ pick a target for ${shortLabel(sendFor)} · Esc` : selectedAgent ? `⇢ send ${shortLabel(selectedAgent)} to… · G` : "⇢ send to… (select an agent)"}
            </Button>)}
          </div>
          {view === "3d" && (noRays !== undefined || noTopology !== undefined || picking || sendFor !== undefined || ((showRays || showTopology) && !selectedAgent) || (overlay !== "truth" && (!selectedAgent || ideal)) || overlay === "difference" || (showExplore && !selectedAgent)) && (
            <div className="scene-hint" data-testid="scene-hint">
              {(noRays !== undefined || noTopology !== undefined) && (
                <span className="muted" data-testid="overlay-off-reason">
                  Rays and frontiers are off in replay: {noRays ?? noTopology}
                </span>
              )}
              {picking && (
                <span className="muted" data-testid="scene-sandbox-picking">
                  Click a target for the Strategy test · Esc
                </span>
              )}
              {(showRays || showTopology) && !selectedAgent && <span className="muted">Select an agent to see its rays and frontiers.</span>}
              {overlay !== "truth" && !selectedAgent && <span className="muted">Select an agent to see its map.</span>}
              {overlay !== "truth" && ideal && (
                <span className="muted" data-testid="overlay-ideal">
                  ◆ ideal: this agent plans on the ground truth, it has no map of its own.
                </span>
              )}
              {overlay === "difference" && (
                <span className="researcher-banner" role="note" data-testid="scene-researcher-marker">
                  ◆ Researcher view — not visible to the mind
                </span>
              )}
              {showExplore && !selectedAgent && <span className="muted">Select an agent to see its exploration.</span>}
            </div>
          )}
        </>
      )}
      <div className={`scene-area${view === "2d" ? " view-2d" : ""}`} data-view={view}>
        <SceneView interpolator={source.poses} onRenderer={onRenderer} />
        {view === "2d" && (
          <div className="scene-2d" data-testid="scene-2d">
            <Scene2dView source={source} snap={snap} />
          </div>
        )}
        {hover && hoverAgent && (
          <div className="map-tooltip mono" style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip" data-testid="map-tooltip">
            <div>
              {hoverAgent.id} · {shortLabel(hoverAgent.id)} · {hoverAgent.kind.toUpperCase()}
            </div>
            <div className="muted">{actionLabel(views.get(hoverAgent.id)?.action, views.get(hoverAgent.id)?.reflex)}</div>
            {hoverCondition && (
              <div className={hoverCondition.level === "alarm" ? "danger" : "warn"}>
                {hoverCondition.glyph} {hoverCondition.label}
              </div>
            )}
            <div className="muted">click to select</div>
          </div>
        )}
      </div>
    </div>
  );
}
