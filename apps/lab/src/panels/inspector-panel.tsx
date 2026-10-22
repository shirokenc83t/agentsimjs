import "./panels.css";
import { STATUS_STRIDE, type SimLoadedMessage } from "@agentsim/core";
import { identityOf, shortLabel, STATE_GLYPH, useUiContext } from "@agentsim/ui";
import Button from "@mui/material/Button";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePolled, useSource } from "../services.tsx";
import type { RunFeature, RunSnapshot, RunSource } from "../sim/run-source.ts";
import { AGENT_COMMANDS, agentExploreRadius, commandParams } from "../commands.ts";
import { actionLabel, actionState, recoveryLabel, waypointsText, type AgentViews, type CommandView } from "./agent-views.ts";
import { MindViewSection } from "./mind-view-section.tsx";
import { PlanQueryTable, StrategyRow } from "./plan-query-table.tsx";
import { querySelection, useQuerySelection } from "./query-selection.ts";
import { asResearcherCellBeliefs } from "./researcher-data.ts";
import { RESEARCHER_BANNER, ResearcherSection } from "./researcher-section.tsx";
import { useSimStream } from "./use-sim-stream.ts";
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

/** The charge as a bar of ten cells (block characters): the alarm colour at or under the critical level, the warning colour under a third. */
function BatteryBar(props: { soc: number; critical: number | undefined }) {
  const cells = Math.max(0, Math.min(10, Math.round(props.soc * 10)));
  const tone = props.critical !== undefined && props.soc <= props.critical ? "st-alm" : props.soc < 0.33 ? "st-warn" : "st-ok";
  return (
    <span className={`bar mono ${tone}`} aria-hidden="true">
      {"█".repeat(cells)}
      <s>{"░".repeat(10 - cells)}</s>
    </span>
  );
}

/** A live-only section: its content while the source has it, else the reason it is off (a recording has no such data). */
function Unavailable(props: { source: RunSource; feature: RunFeature; title: string; children: ReactNode }) {
  const why = props.source.unavailable(props.feature);
  if (why === undefined) return <>{props.children}</>;
  return (
    <section className="inspector-section" data-testid={`inspector-off-${props.feature}`}>
      <h4>{props.title}</h4>
      <p className="muted">Not available in replay: {why}</p>
    </section>
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
function CommandsSection(props: { id: string; kind: string; body: Record<string, unknown>; source: RunSource; command: CommandView | undefined }) {
  const { id, kind, body, source, command } = props;
  const [altitude, setAltitude] = useState("");
  const parsed = Number(altitude);
  const altitudeM = altitude.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  // The radius of an exploration iteration (ADR-0040): empty = the agent's configured one, shown as the placeholder.
  const [radius, setRadius] = useState("");
  const parsedRadius = Number(radius);
  const radiusM = radius.trim() !== "" && Number.isFinite(parsedRadius) && parsedRadius > 0 ? parsedRadius : undefined;
  const configuredRadius = agentExploreRadius(source.snapshot().run, id);
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
      <Row k="explore radius">
        <input
          className="mono"
          style={{ width: "6em" }}
          type="number"
          min={1}
          step={1}
          placeholder={configuredRadius === undefined ? "default" : String(configuredRadius)}
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          aria-label="explore radius (m)"
          data-testid="command-explore-radius"
        />{" "}
        m
      </Row>
      <Row k="run">
        {AGENT_COMMANDS.map((c) => (
          <Button
            key={c.op}
            size="small"
            variant="outlined"
            color="inherit"
            sx={{ marginRight: 0.5 }}
            disabled={source.unavailable("commands") !== undefined}
            title={source.unavailable("commands")}
            onClick={() => source.command(id, c.op, commandParams(c.op, body, altitudeM, radiusM))}
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

function AgentInspector(props: { id: string; snap: RunSnapshot; source: RunSource; views: Map<string, AgentViews> }) {
  const { id, snap, source, views } = props;
  const queries = usePlanQueries(source, id);
  const picked = useQuerySelection();
  const selectedQuery = picked?.agentId === id && queries.some((q) => q.queryId === picked.queryId) ? picked.queryId : undefined;
  const run = snap.run as SimLoadedMessage;
  const index = snap.entityIds.indexOf(id);
  const agent = run.agents.find((a) => a.id === id);
  if (!agent || index < 0) return <p className="muted">Agent {id} is not in this run.</p>;
  const pose = source.pose(index);
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
      {/* The ID card: who this is and what it is doing, before any block. */}
      <div className="idcard" data-testid="inspector-idcard">
        <h3>
          <span className={`agent-swatch ${identityOf(index).style}`} style={{ ["--swatch" as string]: `var(--agent-${identityOf(index).colorIndex})` }} /> <span className="id mono">{id}</span>{" "}
          <span className="muted">
            {[agent.key, agent.kind.toUpperCase(), typeof body["drive"] === "string" ? body["drive"] : undefined].filter((x) => x !== undefined && x !== "").join(" · ")}
          </span>
        </h3>
        <div className="mono" data-testid="inspector-idcard-state">
          <span className={`st-${state}`}>
            {STATE_GLYPH[state]} {actionLabel(action)}
          </span>
          {action && <span className="muted nowrap"> · since {action.startedAtS.toFixed(1)} s</span>}
        </div>
      </div>
      <Unavailable source={source} feature="mindView" title="What the mind receives">
        <MindViewSection source={source} agentId={id} runId={run.runId} />
      </Unavailable>
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
          {st && (
            <>
              {" "}
              <BatteryBar soc={st[o] ?? 0} critical={battery?.criticalSoc} />
            </>
          )}
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
        {agent.kind === "ugv" && (
          <Row k="recovery" testId="inspector-recovery">
            {recoveryLabel(v?.recovery)}
          </Row>
        )}
        {v?.reflex && (
          <Row k="last reflex" testId="inspector-reflex">
            <span className="st-warn">
              {STATE_GLYPH.warn} {v.reflex.reflex} · {v.reflex.code}
              {v.reflex.then ? ` → ${v.reflex.then}` : ""} @ {v.reflex.atS.toFixed(1)} s
            </span>
          </Row>
        )}
      </Section>
      <CommandsSection id={id} kind={agent.kind} body={body} source={source} command={v?.command} />
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
      <Unavailable source={source} feature="strategyTest" title="Strategy test">
        <StrategyTestSection key={`${run.runId}/${id}`} source={source} agentId={id} />
      </Unavailable>
      <Unavailable source={source} feature="researcher" title="Beliefs versus ground truth">
        <ResearcherSection source={source} agentId={id} runId={run.runId} />
      </Unavailable>
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
function clearanceM(source: RunSource, i: number, j: number, res: number, maxM: number): number | undefined {
  const r = Math.ceil(maxM / res);
  let best: number | undefined;
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      const c = source.cellAt(i + di, j + dj);
      if (!c || c.occupancy !== 1) continue;
      const d = Math.max(0, Math.hypot(di, dj) - 0.5) * res;
      if (d <= maxM && (best === undefined || d < best)) best = d;
    }
  }
  return best;
}

/** What every agent believes of the cell, next to the truth: researcher data, live only. A belief that differs from the truth is flagged. */
function CellBeliefs(props: { source: RunSource; runId: string; i: number; j: number; occupied: boolean; entityIds: readonly string[] }) {
  const { source, runId, i, j, occupied, entityIds } = props;
  useEffect(() => {
    source.send({ type: "cellWatch", cell: { i, j } });
    return () => source.send({ type: "cellWatch", cell: null });
  }, [source, runId, i, j]);
  const msg = useSimStream(source, "cellBeliefs", (m) => m.runId === runId && m.i === i && m.j === j, [runId, i, j]);
  const data = msg ? asResearcherCellBeliefs(msg) : undefined;
  return (
    <section className="inspector-section researcher-view" data-testid="cell-beliefs">
      <h4>
        <span className="kind-tag mono">◆ RESEARCHER</span> What each agent believes
      </h4>
      <p className="researcher-banner" role="note" data-testid="cell-beliefs-banner">
        ◆ {RESEARCHER_BANNER}
      </p>
      {data ? (
        <dl className="kv">
          {data.agents.map((a) => {
            const index = entityIds.indexOf(a.agentId);
            const wrong = (a.state === "free" && occupied) || (a.state === "occupied" && !occupied);
            return (
              <div key={a.agentId} className="belief-row" data-testid={`cell-belief-${a.agentId}`} data-state={a.state} data-wrong={wrong ? "true" : "false"} style={{ display: "contents" }}>
                <dt>
                  <span className={`agent-swatch ${identityOf(index).style}`} style={{ ["--swatch" as string]: `var(--agent-${identityOf(index).colorIndex})` }} /> {a.agentId} <span className="muted">{shortLabel(a.agentId)}</span>
                </dt>
                <dd className={wrong ? "st-warn" : undefined}>
                  {a.state === "ideal" ? "◆ ideal: the truth" : a.state === "unknown" ? "? unknown" : wrong ? `▲ believes ${a.state}: actually ${occupied ? "blocked" : "free"}` : `✓ ${a.state}`}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="muted">Waiting for the worker…</p>
      )}
    </section>
  );
}

function CellInspector(props: { id: string; snap: RunSnapshot; source: RunSource }) {
  const [si, sj] = props.id.split(",").map(Number);
  const i = si ?? 0;
  const j = sj ?? 0;
  const res = props.snap.grid?.dims.resolutionM ?? 1;
  const c = props.source.cellAt(i, j);
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
  const clear = clearanceM(props.source, i, j, res, 5);
  return (
    <div data-testid="inspector-cell">
      <div className="idcard">
        <h3 className="mono">
          <span className="id">cell {props.id}</span>
        </h3>
      </div>
      <Section title="Cell · truth ◆ researcher" testId="inspector-cell-truth">
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
      <Unavailable source={props.source} feature="cellBeliefs" title="What each agent believes">
        <CellBeliefs source={props.source} runId={props.snap.runId ?? ""} i={i} j={j} occupied={occupied} entityIds={props.snap.entityIds} />
      </Unavailable>
    </div>
  );
}

/**
 * Inspector (UI-SPEC §4): details of the selection from the shared UI context (ADR-0016). Agents: tick
 * state, action and last reflex, last plan, effective configuration with the source of each planning field
 * (ADR-0028), body warnings. Cells: layers, the effective air rule for unknown heights, clearance.
 */
export function InspectorPanel() {
  const source = useSource();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const views = useAgentViews(source);
  const selection = useUiContext((s) => s.selection);
  // The two tabs: the agent and the cell last selected. Selecting one shows its tab; either tab can be opened for the other one's last selection.
  const [tab, setTab] = useState<"agent" | "cell">("agent");
  // What each agent believes of a cell is read from the live run's maps, which a recording does not hold: in a replay the tab is off, and says why.
  const cellOff = source.unavailable("cellBeliefs");
  const [last, setLast] = useState<{ agent?: string | undefined; cell?: string | undefined; runId?: string | undefined }>({});
  const runId = snap.runId;
  useEffect(() => {
    setLast((cur) => (cur.runId === runId ? cur : { runId }));
  }, [runId]);
  useEffect(() => {
    if (selection?.kind === "agent") {
      setLast((cur) => ({ ...cur, agent: selection.id }));
      setTab("agent");
    } else if (selection?.kind === "cell") {
      setLast((cur) => ({ ...cur, cell: selection.id }));
      if (!cellOff) setTab("cell");
    }
  }, [selection, cellOff]);
  const agentId = selection?.kind === "agent" ? selection.id : last.agent;
  const cellId = selection?.kind === "cell" ? selection.id : last.cell;
  let body: ReactNode = <p className="muted">Select an agent or a cell (Scene, Explorer).</p>;
  if (!snap.run) body = <p className="muted">No run loaded.</p>;
  else if (tab === "agent" && agentId) body = <AgentInspector id={agentId} snap={snap} source={source} views={views} />;
  else if (tab === "cell" && cellId && !cellOff) body = <CellInspector id={cellId} snap={snap} source={source} />;
  else if (tab === "cell") body = <p className="muted">Click a cell in the Scene to see it here.</p>;
  return (
    <div className="panel inspector" data-testid="inspector">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector">
        {(["agent", "cell"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t && !(t === "cell" && cellOff)}
            aria-disabled={t === "cell" && cellOff !== undefined ? true : undefined}
            className={`itab${tab === t && !(t === "cell" && cellOff) ? " on" : ""}`}
            data-tip={t === "cell" && cellOff !== undefined ? `Live only: ${cellOff}` : undefined}
            onClick={() => (t === "cell" && cellOff !== undefined ? undefined : setTab(t))}
            data-testid={`inspector-tab-${t}`}
          >
            {t === "agent" ? "AGENT" : "CELL"}
          </button>
        ))}
      </div>
      {cellOff !== undefined && (
        <p className="muted inspector-live-only" data-testid="inspector-cell-off">
          CELL is live only: {cellOff}
        </p>
      )}
      {body}
    </div>
  );
}
