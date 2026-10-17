import "./panels.css";
import { STATUS_STRIDE, type SimLoadedMessage } from "@agentsim/core";
import { agentColorIndex, STATE_GLYPH, useUiContext } from "@agentsim/ui";
import Button from "@mui/material/Button";
import { useCallback, useState, type ReactNode } from "react";
import { usePolled, useServices } from "../services.tsx";
import type { SimClient, SimSnapshot } from "../sim/sim-client.ts";
import { AGENT_COMMANDS, commandParams } from "../commands.ts";
import { actionLabel, actionState, waypointsText, type AgentViews, type CommandView } from "./agent-views.ts";
import { MindViewSection } from "./mind-view-section.tsx";
import { PlanQueryTable, StrategyRow } from "./plan-query-table.tsx";
import { querySelection, useQuerySelection } from "./query-selection.ts";
import { ResearcherSection } from "./researcher-section.tsx";
import { useAgentViews } from "./use-agent-views.ts";
import { usePlanQueries } from "./use-plan-queries.ts";
import { StrategyTestSection } from "./strategy-test-section.tsx";

const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(0);
const m = (v: number, digits = 2) => `${v.toFixed(digits)} m`;

function Section(props: { title: string; testId?: string; children: ReactNode }) {
  return (
    <section className="inspector-section" data-testid={props.testId}>
      <h4>{props.title}</h4>
      <dl className="kv">{props.children}</dl>
    </section>
  );
}

function Row(props: { k: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt>{props.k}</dt>
      <dd data-testid={props.testId}>{props.children}</dd>
    </>
  );
}

interface AgentConfig {
  readonly planning?: Record<string, unknown>;
  readonly planningSources?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly beliefs?: { readonly init?: unknown; readonly idealized?: boolean };
  readonly beliefsSource?: string;
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}

interface EffectiveStrategy {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly root: unknown;
}

const isStrategy = (v: unknown): v is EffectiveStrategy => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string" && typeof (v as { hash?: unknown }).hash === "string";

const beliefInit = (i: unknown): string => (typeof i === "string" ? i : i && typeof i === "object" && "prior" in i ? `prior ${String((i as { prior: unknown }).prior)}` : "unknown");

/** Scalar body parameters worth showing (nested battery/energy are shown flattened). */
function bodyRows(body: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") rows.push([k, String(v)]);
    else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "number") rows.push([`${k}.${k2}`, String(v2)]);
  }
  return rows;
}

/**
 * Researcher commands (ADR-0015 addition of 2026-10-12): world scope, recorded as run inputs. Every button is always
 * available: preconditions still apply, so a command the agent cannot run now is refused with its code, shown here.
 */
function CommandsSection(props: { id: string; kind: string; body: Record<string, unknown>; sim: SimClient; command: CommandView | undefined }) {
  const { id, kind, body, sim, command } = props;
  const [altitude, setAltitude] = useState("");
  const parsed = Number(altitude);
  const altitudeM = altitude.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  return (
    <Section title="Commands (researcher, world scope)" testId="inspector-commands">
      <Row k="send">
        <span className="muted">Send to… (G) in the Scene</span>
      </Row>
      {kind === "uav" && (
        <Row k="altitude">
          <input
            className="mono"
            style={{ width: "6em" }}
            type="number"
            min={1}
            step={1}
            placeholder={String((body["cruiseAltitudeM"] as number | undefined) ?? 10)}
            value={altitude}
            onChange={(e) => setAltitude(e.target.value)}
            aria-label="takeoff altitude (m)"
            data-testid="command-altitude"
          />{" "}
          m
        </Row>
      )}
      <Row k="run">
        {AGENT_COMMANDS.map((c) => (
          <Button
            key={c.op}
            size="small"
            variant="outlined"
            color="inherit"
            sx={{ marginRight: 0.5 }}
            onClick={() => sim.command(id, c.op, commandParams(c.op, body, altitudeM))}
            data-testid={`command-${c.op}`}
          >
            {c.title}
          </Button>
        ))}
      </Row>
      <Row k="last command" testId="inspector-command-result">
        {command ? (
          <span className={`mono ${command.ok ? "st-ok" : "st-alm"}`}>
            {command.ok ? STATE_GLYPH.ok : STATE_GLYPH.alm} {command.name} · {command.ok ? "accepted" : `refused · ${command.failure ?? "?"}`} @ {command.atS.toFixed(1)} s
          </span>
        ) : (
          "none yet"
        )}
      </Row>
    </Section>
  );
}

function AgentInspector(props: { id: string; snap: SimSnapshot; sim: SimClient; views: Map<string, AgentViews> }) {
  const { id, snap, sim, views } = props;
  const queries = usePlanQueries(sim, id);
  const picked = useQuerySelection();
  const selectedQuery = picked?.agentId === id && queries.some((q) => q.queryId === picked.queryId) ? picked.queryId : undefined;
  const run = snap.run as SimLoadedMessage;
  const index = snap.entityIds.indexOf(id);
  const agent = run.agents.find((a) => a.id === id);
  if (!agent || index < 0) return <p className="muted">Agent {id} is not in this run.</p>;
  const pose = sim.pose(index);
  const st = snap.agentStatus;
  const o = index * STATUS_STRIDE;
  const v = views.get(id);
  const action = v?.action;
  const state = actionState(action);
  const cfg = (agent.config ?? {}) as AgentConfig;
  const body = cfg.body ?? {};
  const battery = body["battery"] as { criticalSoc?: number } | undefined;
  const ideal = cfg.beliefs?.idealized === true;
  const strategy = isStrategy(cfg.planning?.["strategy"]) ? cfg.planning["strategy"] : undefined;
  return (
    <div data-testid="inspector-agent">
      <h3>
        <span className="agent-swatch" style={{ backgroundColor: `var(--agent-${agentColorIndex(id)})` }} /> <span className="mono">{id}</span>{" "}
        <span className="muted">{agent.key ?? ""} · {agent.kind.toUpperCase()}</span>
      </h3>
      <MindViewSection sim={sim} agentId={id} runId={run.runId} />
      <Section title="Beliefs (initial map)" testId="inspector-beliefs-init">
        <Row k="initial map" testId="inspector-init">
          {ideal ? (
            <span className="st-warn">◆ ideal — plans on the ground truth (baseline)</span>
          ) : (
            <span className="mono">{beliefInit(cfg.beliefs?.init)}</span>
          )}{" "}
          <span className="source-tag">{cfg.beliefsSource ?? "?"}</span>
        </Row>
      </Section>
      <Section title="State (last tick)" testId="inspector-state">
        <Row k="position">{pose ? `${m(pose.x)}, ${m(pose.y)}${agent.kind === "uav" ? `, ${m(pose.z)}` : ""}` : "—"}</Row>
        <Row k="heading">{pose ? `${deg(pose.headingRad)}°` : "—"}</Row>
        <Row k="speed">{st ? `${(st[o + 1] ?? 0).toFixed(2)} m/s` : "—"}</Row>
        <Row k="battery" testId="inspector-battery">
          {st ? `${((st[o] ?? 0) * 100).toFixed(1)} %` : "—"}
          {battery?.criticalSoc !== undefined ? ` (critical ${(battery.criticalSoc * 100).toFixed(0)} %)` : ""}
        </Row>
        <Row k="odometer">{st ? m(st[o + 2] ?? 0, 1) : "—"}</Row>
        {agent.kind === "uav" && <Row k="airborne">{st && (st[o + 3] ?? 0) > 0.5 ? "yes" : "no"}</Row>}
      </Section>
      <Section title="Action" testId="inspector-action">
        <Row k="action" testId="inspector-action-label">
          <span className={`mono st-${state}`}>
            {STATE_GLYPH[state]} {actionLabel(action)}
          </span>
        </Row>
        {action && <Row k="id">{action.actionId}</Row>}
        {v?.reflex && (
          <Row k="last reflex" testId="inspector-reflex">
            <span className="st-warn">
              {STATE_GLYPH.warn} {v.reflex.reflex} · {v.reflex.code}
              {v.reflex.then ? ` → ${v.reflex.then}` : ""} @ {v.reflex.atS.toFixed(1)} s
            </span>
          </Row>
        )}
      </Section>
      <CommandsSection id={id} kind={agent.kind} body={body} sim={sim} command={v?.command} />
      <Section title="Last plan" testId="inspector-plan">
        {v?.plan ? (
          <>
            <Row k="algorithm">{v.plan.algorithm}</Row>
            <Row k="expansions" testId="inspector-plan-expansions">
              {v.plan.expansionsCharged}
            </Row>
            <Row k="completed tick">{v.plan.completedTick}</Row>
            <Row k="path" testId="inspector-plan-path">
              {m(v.plan.lengthM, 1)} · {v.plan.waypoints.length} waypoints
            </Row>
            <Row k="waypoints" testId="inspector-plan-waypoints">
              <span className="mono">{waypointsText(v.plan.waypoints)}</span>
            </Row>
          </>
        ) : (
          <Row k="plan">none yet</Row>
        )}
      </Section>
      <section className="inspector-section" data-testid="inspector-queries">
        <h4>Planning queries</h4>
        <PlanQueryTable rows={queries} selected={selectedQuery} onSelect={(queryId) => querySelection.set({ agentId: id, queryId })} />
      </section>
      <Section title="Effective configuration" testId="inspector-config">
        {strategy && <StrategyRow strategy={strategy} source={cfg.planningSources?.["algorithm"] ?? "?"} />}
        {(cfg.warnings ?? []).map((w) => (
          <Row key={w.code} k="warning" testId={`inspector-config-warning-${w.code}`}>
            <span className="st-warn">
              {STATE_GLYPH.warn} <span className="mono">{w.code}</span> {w.message}
            </span>
          </Row>
        ))}
        {Object.entries(cfg.planning ?? {})
          .filter(([k]) => !(strategy && (k === "strategy" || k === "algorithm")))
          .map(([k, val]) => (
          <Row key={k} k={k}>
            <span className="mono">{typeof val === "object" ? JSON.stringify(val) : String(val)}</span>{" "}
            <span className="source-tag">{cfg.planningSources?.[k] ?? "?"}</span>
          </Row>
        ))}
        {/* Fields shown above as planning fields (with their source) are not repeated from the body. */}
        {bodyRows(body)
          .filter(([k]) => !(k in (cfg.planning ?? {})))
          .map(([k, val]) => (
          <Row key={k} k={k}>
            <span className="mono">{val}</span>
          </Row>
        ))}
      </Section>
      <StrategyTestSection key={`${run.runId}/${id}`} sim={sim} agentId={id} />
      <ResearcherSection sim={sim} agentId={id} runId={run.runId} />
      {agent.warnings && agent.warnings.length > 0 && (
        <Section title="Body warnings" testId="inspector-warnings">
          {agent.warnings.map((w) => (
            <Row key={w.code} k={w.code}>
              <span className="st-warn">
                {STATE_GLYPH.warn} {w.message}
              </span>
            </Row>
          ))}
        </Section>
      )}
    </div>
  );
}

/** Distance (m) from a cell's centre to the nearest occupied cell received so far, searched up to `maxM`. */
function clearanceM(sim: SimClient, i: number, j: number, res: number, maxM: number): number | undefined {
  const r = Math.ceil(maxM / res);
  let best: number | undefined;
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      const c = sim.cellAt(i + di, j + dj);
      if (!c || c.occupancy !== 1) continue;
      const d = Math.max(0, Math.hypot(di, dj) - 0.5) * res;
      if (d <= maxM && (best === undefined || d < best)) best = d;
    }
  }
  return best;
}

function CellInspector(props: { id: string; snap: SimSnapshot; sim: SimClient }) {
  const [si, sj] = props.id.split(",").map(Number);
  const i = si ?? 0;
  const j = sj ?? 0;
  const res = props.snap.grid?.dims.resolutionM ?? 1;
  const c = props.sim.cellAt(i, j);
  if (!c) return <p className="muted">Cell {props.id} is outside the grid or not loaded yet.</p>;
  const occupied = c.occupancy === 1;
  const unknownHeight = occupied && c.heightDm === 0;
  const air = !occupied
    ? "free for ground and air"
    : !unknownHeight
      ? `blocks aircraft below ${(c.heightDm / 10).toFixed(1)} m`
      : c.defaultObstacleHeightM !== undefined
        ? `unknown height: the scenario assumes ${c.defaultObstacleHeightM} m (defaultObstacleHeightM)`
        : "unknown height: blocks aircraft at any altitude (no defaultObstacleHeightM)";
  const clear = clearanceM(props.sim, i, j, res, 5);
  return (
    <div data-testid="inspector-cell">
      <h3 className="mono">cell {props.id}</h3>
      <Section title="Cell">
        <Row k="centre">{`${m((i + 0.5) * res)}, ${m((j + 0.5) * res)}`}</Row>
        <Row k="occupancy" testId="inspector-cell-occupancy">
          <span className={occupied ? "st-alm" : "st-ok"}>{occupied ? `${STATE_GLYPH.alm} blocked` : `${STATE_GLYPH.ok} free`}</span>
        </Row>
        <Row k="terrain cost">{c.terrainCost === 0 ? `${STATE_GLYPH.alm} impassable (0)` : String(c.terrainCost)}</Row>
        <Row k="height">{unknownHeight ? "▨ unknown" : `${(c.heightDm / 10).toFixed(1)} m`}</Row>
        <Row k="air rule" testId="inspector-cell-air">
          {air}
        </Row>
        <Row k="clearance">{clear === undefined ? "> 5 m" : m(clear)}</Row>
      </Section>
    </div>
  );
}

/**
 * Inspector (UI-SPEC §4): details of the selection from the shared UI context (ADR-0016). Agents: tick
 * state, action and last reflex, last plan, effective configuration with the source of each planning field
 * (ADR-0028), body warnings. Cells: layers, the effective air rule for unknown heights, clearance.
 */
export function InspectorPanel() {
  const { sim } = useServices();
  const snap = usePolled(useCallback(() => sim.snapshot(), [sim]), 100);
  const views = useAgentViews(sim);
  const selection = useUiContext((s) => s.selection);
  let body: ReactNode = <p className="muted">Select an agent or a cell (Scene, Explorer).</p>;
  if (!snap.run) body = <p className="muted">No run loaded.</p>;
  else if (selection?.kind === "agent") body = <AgentInspector id={selection.id} snap={snap} sim={sim} views={views} />;
  else if (selection?.kind === "cell") body = <CellInspector id={selection.id} snap={snap} sim={sim} />;
  return (
    <div className="panel inspector" data-testid="inspector">
      {body}
    </div>
  );
}
