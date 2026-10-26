import "../panels.css";
import type { AgentFacts } from "@agentsim/core";
import type { RunConfigDocument } from "@agentsim/scenarios";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { actionMenu, alongList, defaultArgs, fieldIssues, insertStep, missionOf, missionStatus, moveStep, removeStep, withMission, type MissionStep } from "./mission-model.ts";

/** One agent a mission can be given: only an agent with a key can have one (the run configuration names agents by key). */
export interface MissionAgent {
  readonly id: string;
  readonly key: string;
  readonly kind: "uav" | "ugv";
  /** The state it starts in, for the availability of the first steps. */
  readonly facts: AgentFacts;
  readonly cruiseAltitudeM: number | undefined;
  readonly start: { readonly x: number; readonly y: number } | undefined;
  readonly base: { readonly x: number; readonly y: number } | undefined;
}

/** The extent of the world in metres, for the side map. */
export interface MissionWorld {
  readonly wM: number;
  readonly hM: number;
}

const ARGS: Readonly<Record<string, readonly { key: string; label: string; unit: string }[]>> = {
  takeoff: [{ key: "altitudeM", label: "altitude", unit: "m" }],
  goTo: [
    { key: "xM", label: "x", unit: "m" },
    { key: "yM", label: "y", unit: "m" },
  ],
  explore: [{ key: "radiusM", label: "radius", unit: "m" }],
  hold: [{ key: "durationS", label: "for", unit: "s" }],
};

/** A typed number: a dot or a comma is the decimal mark; nothing for an empty or half-typed text. */
const parseNumber = (t: string): number | undefined => {
  const s = t.trim().replace(",", ".");
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

function ArgInput(props: { label: string; unit: string; value: number | undefined; onChange: (v: number | undefined) => void; testId: string; invalid: boolean }) {
  const [text, setText] = useState(props.value === undefined ? "" : String(props.value));
  useEffect(() => setText((cur) => (parseNumber(cur) === props.value ? cur : props.value === undefined ? "" : String(props.value))), [props.value]);
  return (
    <label className={`ms-arg${props.invalid ? " bad" : ""}`}>
      <span className="muted">{props.label}</span>
      <input
        className="mono"
        value={text}
        inputMode="decimal"
        aria-label={props.label}
        aria-invalid={props.invalid}
        data-testid={props.testId}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(parseNumber(e.target.value));
        }}
      />
      <span className="muted">{props.unit}</span>
    </label>
  );
}

const GLYPH = { ok: "✓", warn: "▲", err: "✕" } as const;

/**
 * The mission step editor (F3c M1, UI-SPEC section 3): per agent, the list of actions it runs one after the other, each row saying from the state the steps before it leave whether it can
 * run (the start check's own rule), with its arguments checked in words and, for a go to, a point picked on a map of the world. The list is the `sequence` script of the agent's `s1` mind in
 * the run configuration (`minds.byAgent`), so it is in the run's hash and in the JSON view next to it. Keys: Insert adds after the selected step, Alt+Up and Alt+Down move it, Delete removes
 * it, Ctrl+Z undoes.
 */
export function MissionSection(props: { draft: RunConfigDocument; onChange: (d: RunConfigDocument) => void; agents: readonly MissionAgent[]; world: MissionWorld | undefined; pointedError: string | undefined }) {
  const { draft, agents } = props;
  const withMissions = agents.filter((a) => missionOf(draft, a.key).length > 0);
  const [agentKey, setAgentKey] = useState(() => (withMissions[0] ?? agents[0])?.key ?? "");
  const agent = agents.find((a) => a.key === agentKey) ?? agents[0];
  const steps = useMemo(() => (agent ? missionOf(draft, agent.key) : []), [draft, agent]);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [picking, setPicking] = useState<number | undefined>(undefined);
  // Undo: the lists before each edit, per agent.
  const history = useRef<Map<string, MissionStep[][]>>(new Map());
  const list = useRef<HTMLOListElement>(null);
  const addRef = useRef<HTMLSelectElement>(null);

  if (!agent) {
    return (
      <section className="fs mission" data-section="mission" data-testid="rc-mission">
        <h4 className="sec">
          <b>7 · MISSION</b>
          <span className="rule" />
        </h4>
        <p className="muted">No agent has a key in this scenario: a mission is given to an agent by its key.</p>
      </section>
    );
  }
  const rows = alongList(steps, agent.facts);
  const status = missionStatus(steps, agent.facts);
  const menu = actionMenu(agent.kind);

  const commit = (next: readonly MissionStep[]) => {
    const h = history.current.get(agent.key) ?? [];
    history.current.set(agent.key, [...h.slice(-49), steps]);
    props.onChange(withMission(draft, agent.key, next));
  };
  const undo = () => {
    const h = history.current.get(agent.key) ?? [];
    const prev = h[h.length - 1];
    if (!prev) return;
    history.current.set(agent.key, h.slice(0, -1));
    props.onChange(withMission(draft, agent.key, prev));
    setSelected(undefined);
  };
  const add = (name: string, at = selected === undefined ? steps.length : selected + 1) => {
    const step: MissionStep = { action: name, args: defaultArgs(name, { ...(agent.cruiseAltitudeM === undefined ? {} : { cruiseAltitudeM: agent.cruiseAltitudeM }), x: agent.start?.x ?? 0, y: agent.start?.y ?? 0 }) };
    commit(insertStep(steps, at, step));
    setSelected(at);
  };
  const setArg = (i: number, key: string, value: number | undefined) => {
    const step = steps[i] as MissionStep;
    const args = { ...(step.args as Record<string, unknown> | undefined) };
    if (value === undefined) delete args[key];
    else args[key] = value;
    commit(steps.map((s, k) => (k === i ? { action: s.action, args } : s)));
  };
  const onKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (picking !== undefined && e.key === "Escape") {
      e.stopPropagation();
      setPicking(undefined);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if (e.key === "Insert") {
      e.preventDefault();
      addRef.current?.focus();
    } else if (selected === undefined) {
      return;
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = selected + (e.key === "ArrowUp" ? -1 : 1);
      if (to >= 0 && to < steps.length) {
        commit(moveStep(steps, selected, e.key === "ArrowUp" ? -1 : 1));
        setSelected(to);
      }
    } else if (e.key === "Delete") {
      e.preventDefault();
      commit(removeStep(steps, selected));
      setSelected(steps.length > 1 ? Math.min(selected, steps.length - 2) : undefined);
      // The removed row had the focus: the list keeps it, so the keys (and Ctrl+Z) still reach it.
      requestAnimationFrame(() => list.current?.focus());
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.max(0, Math.min(steps.length - 1, selected + (e.key === "ArrowUp" ? -1 : 1))));
    }
  };

  const others = agents.filter((a) => a.key !== agent.key);
  return (
    <section className="fs mission" data-section="mission" data-testid="rc-mission">
      <h4 className="sec">
        <b>7 · MISSION</b>
        <span className="rule" />
        <span data-testid="rc-status-mission">
          {status.errors > 0 ? <span className="st st-alm">✕ {status.errors}</span> : status.warnings > 0 ? <span className="st st-warn">▲ {status.warnings}</span> : <span className="st st-ok">✓</span>}
        </span>
      </h4>
      <div className="ms-head">
        <select className="mono" value={agent.key} onChange={(e) => (setAgentKey(e.target.value), setSelected(undefined), setPicking(undefined))} aria-label="Agent" data-testid="ms-agent">
          {agents.map((a) => (
            <option key={a.key} value={a.key}>
              {a.id} · {a.key} · {a.kind.toUpperCase()} · {missionOf(draft, a.key).length > 0 ? `${missionOf(draft, a.key).length} steps` : "no mission"}
            </option>
          ))}
        </select>
        <span className="muted mono">sequence script · in the run config hash</span>
        <span className="sp" />
        {others.length > 0 && steps.length > 0 && (
          <select
            className="mono"
            value=""
            aria-label="Copy this mission to another agent"
            data-testid="ms-copy"
            onChange={(e) => {
              const to = others.find((a) => a.key === e.target.value);
              if (to) props.onChange(withMission(draft, to.key, steps));
            }}
          >
            <option value="">copy to…</option>
            {others.map((a) => (
              <option key={a.key} value={a.key} disabled={!steps.every((s) => actionMenu(a.kind).find((m) => m.name === s.action)?.supported)}>
                {a.id} · {a.key}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="kt" disabled={steps.length === 0} onClick={() => (commit([]), setSelected(undefined))} data-testid="ms-clear">
          clear
        </button>
      </div>
      <div className="ms-body">
        <div className="ms-left">
          {steps.length === 0 && (
            <p className="muted ms-empty" data-testid="ms-empty">
              No mission: {agent.id} acts only on commands. Add the first step, for instance a take off for a UAV.
            </p>
          )}
          <ol className="ms-steps" ref={list} tabIndex={-1} role="listbox" aria-label={`Steps of ${agent.id}'s mission`} onKeyDown={onKey} data-testid="ms-steps">
            {steps.map((s, i) => {
              const r = rows[i];
              if (!r) return null;
              const issues = fieldIssues(s);
              const glyph = issues.length > 0 ? GLYPH.err : r.ok && !r.blocked ? GLYPH.ok : GLYPH.warn;
              const tone = issues.length > 0 ? "alm" : r.ok && !r.blocked ? "ok" : "warn";
              return (
                <li
                  key={i}
                  className={`ms-row${selected === i ? " sel" : ""}`}
                  role="option"
                  aria-selected={selected === i}
                  tabIndex={selected === i || (selected === undefined && i === 0) ? 0 : -1}
                  onFocus={() => setSelected(i)}
                  onClick={() => setSelected(i)}
                  data-testid={`ms-step-${i}`}
                  data-action={s.action}
                  data-state={tone}
                >
                  <div className="ms-line">
                    <span className="ms-grip" aria-hidden="true">
                      ⋮⋮
                    </span>
                    <span className="ms-i mono">{i + 1}</span>
                    <span className={`st st-${tone}`} data-testid={`ms-glyph-${i}`} aria-label={tone === "ok" ? "can run" : tone === "warn" ? "cannot run from here" : "invalid arguments"}>
                      {glyph}
                    </span>
                    <b className="ms-action mono">{s.action}</b>
                    <span className="ms-args">
                      {(ARGS[s.action] ?? []).map((a) => {
                        const v = (s.args as Record<string, unknown> | undefined)?.[a.key];
                        return <ArgInput key={a.key} label={a.label} unit={a.unit} value={typeof v === "number" ? v : undefined} onChange={(n) => setArg(i, a.key, n)} testId={`ms-arg-${i}-${a.key}`} invalid={issues.some((m) => m.startsWith(a.key))} />;
                      })}
                      {s.action === "goTo" && (
                        <button type="button" className={`kt${picking === i ? " on" : ""}`} aria-pressed={picking === i} onClick={() => setPicking(picking === i ? undefined : i)} data-testid={`ms-pick-${i}`} data-tip="Pick the point on the map">
                          ⌖ pick
                        </button>
                      )}
                      {s.action === "returnToBase" && <span className="muted mono">H home{agent.base ? ` (${agent.base.x}, ${agent.base.y})` : ""}</span>}
                    </span>
                    <span className="ms-after muted mono" data-testid={`ms-after-${i}`}>
                      {r.after === undefined ? "" : `→ ${r.after}`} · {r.resume}
                    </span>
                    <span className="ms-btns">
                      <button type="button" className="kt" disabled={i === 0} onClick={() => (commit(moveStep(steps, i, -1)), setSelected(i - 1))} aria-label={`Move step ${i + 1} up`} data-testid={`ms-up-${i}`}>
                        ↑
                      </button>
                      <button type="button" className="kt" disabled={i === steps.length - 1} onClick={() => (commit(moveStep(steps, i, 1)), setSelected(i + 1))} aria-label={`Move step ${i + 1} down`} data-testid={`ms-down-${i}`}>
                        ↓
                      </button>
                      <button type="button" className="kt" onClick={() => (commit(removeStep(steps, i)), setSelected(undefined))} aria-label={`Remove step ${i + 1}`} data-testid={`ms-remove-${i}`}>
                        ✕
                      </button>
                    </span>
                  </div>
                  {!r.ok && (
                    <p className="ms-hint st-warn" data-testid={`ms-hint-${i}`}>
                      ▲ {r.hint}
                      {r.because ? ` · ${r.because}` : ""}
                      {r.fix && (
                        <button type="button" className="kt" onClick={() => add(r.fix?.insert.action ?? "takeoff", r.fix?.at)} data-testid={`ms-fix-${i}`}>
                          + insert {r.fix.insert.action === "takeoff" ? "take off" : r.fix.insert.action} before step {i + 1}
                        </button>
                      )}
                    </p>
                  )}
                  {issues.map((m) => (
                    <p key={m} className="ms-hint st-alm" data-testid={`ms-error-${i}`}>
                      ✕ step {i + 1} · {s.action} · {m}
                    </p>
                  ))}
                  {r.note && (
                    <p className="ms-hint muted" data-testid={`ms-note-${i}`}>
                      ▲ {r.note}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="ms-add">
            <select
              ref={addRef}
              className="mono"
              value=""
              aria-label="Add a step"
              data-testid="ms-add"
              onChange={(e) => {
                if (e.target.value !== "") add(e.target.value);
              }}
            >
              <option value="">+ add step ▾</option>
              {menu.map((m) => (
                <option key={m.name} value={m.name} disabled={!m.supported}>
                  {m.name}
                  {m.needs ? ` · ${m.needs}` : ""}
                  {m.why ? ` · ${m.why}` : ""}
                </option>
              ))}
            </select>
            <span className="muted mono">Ins add · Alt+↑ ↓ move · Del remove · Ctrl+Z undo</span>
          </div>
          <p className="ms-foot mono" data-testid="ms-valid" data-valid={status.valid}>
            {status.valid ? (
              <span className="st st-ok">
                ✓ valid · {status.steps} step{status.steps === 1 ? "" : "s"} · {agent.id}
              </span>
            ) : (
              <span className={`st ${status.errors > 0 ? "st-alm" : "st-warn"}`}>
                {status.errors > 0 ? "✕" : "▲"} {status.errors + status.warnings} to fix · {status.steps} steps · {agent.id}
              </span>
            )}
            <span className="muted"> · {others.length === 0 ? "no other agent" : `${others.map((a) => a.id).join(", ")} keep their minds`}</span>
            {props.pointedError && <span className="st st-alm"> · {props.pointedError}</span>}
          </p>
        </div>
        <MissionMap
          world={props.world}
          agent={agent}
          steps={steps}
          picking={picking}
          onPick={(x, y) => {
            if (picking === undefined) return;
            commit(steps.map((s, k) => (k === picking ? { action: s.action, args: { ...(s.args as Record<string, unknown> | undefined), xM: x, yM: y } } : s)));
            setPicking(undefined);
          }}
        />
      </div>
    </section>
  );
}

/** A side map of the world: the agent's start, its base, the points of its go to steps numbered and joined in order; a click sets the point of the step being picked. */
function MissionMap(props: { world: MissionWorld | undefined; agent: MissionAgent; steps: readonly MissionStep[]; picking: number | undefined; onPick: (x: number, y: number) => void }) {
  const { world, agent, steps } = props;
  if (!world) return <div className="ms-map muted">No map of the world is loaded.</div>;
  const W = 240;
  const H = Math.max(80, Math.round((W * world.hM) / world.wM));
  const sx = (x: number) => (x / world.wM) * W;
  const sy = (y: number) => H - (y / world.hM) * H;
  const pts = steps.flatMap((s, i) => {
    const a = s.args as { xM?: unknown; yM?: unknown } | undefined;
    return s.action === "goTo" && typeof a?.xM === "number" && typeof a.yM === "number" ? [{ i, x: a.xM, y: a.yM }] : [];
  });
  const path = [...(agent.start ? [{ x: agent.start.x, y: agent.start.y }] : []), ...pts.map((p) => ({ x: p.x, y: p.y }))];
  const picking = props.picking !== undefined;
  return (
    <div className="ms-map" data-testid="ms-map">
      <p className="muted mono">
        {picking ? `click to set the point of step ${(props.picking as number) + 1} · Esc cancels` : "map of the world · pick a point with ⌖ on a go to step"}
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`Map of the world with the points of ${agent.id}'s mission`}
        className={picking ? "picking" : undefined}
        onClick={(e) => {
          if (!picking) return;
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * world.wM;
          const y = (1 - (e.clientY - r.top) / r.height) * world.hM;
          props.onPick(Math.round(Math.max(0, Math.min(world.wM, x)) * 10) / 10, Math.round(Math.max(0, Math.min(world.hM, y)) * 10) / 10);
        }}
        data-testid="ms-map-svg"
      >
        <rect className="ms-world" x={0} y={0} width={W} height={H} />
        {path.length > 1 && <polyline className="ms-path" points={path.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")} />}
        {agent.base && (
          <text className="ms-pin" x={sx(agent.base.x)} y={sy(agent.base.y)} textAnchor="middle" dominantBaseline="middle">
            H
          </text>
        )}
        {agent.start && <circle className="ms-start" cx={sx(agent.start.x)} cy={sy(agent.start.y)} r={3} />}
        {pts.map((p) => (
          <g key={p.i} data-testid={`ms-pin-${p.i}`}>
            <circle className="ms-dot" cx={sx(p.x)} cy={sy(p.y)} r={7} />
            <text className="ms-pin" x={sx(p.x)} y={sy(p.y)} textAnchor="middle" dominantBaseline="middle">
              {p.i + 1}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

interface ScenarioView {
  readonly world?: { readonly sizeCells?: { readonly x: number; readonly y: number }; readonly resolutionM?: number };
  readonly agents?: readonly { readonly key?: string; readonly start?: { readonly xM: number; readonly yM: number; readonly zM?: number }; readonly base?: { readonly xM: number; readonly yM: number } }[];
}

/** The agents a mission can be given (those with a key), with the state each starts in, read from the loaded run and its scenario document (as stored: it is not parsed here). */
export function missionAgentsOf(
  agents: readonly { readonly id: string; readonly key?: string; readonly kind: "uav" | "ugv"; readonly config?: unknown }[],
  scenario: unknown,
): { readonly agents: MissionAgent[]; readonly world: MissionWorld | undefined } {
  const doc = (scenario ?? {}) as ScenarioView;
  const res = doc.world?.resolutionM;
  const size = doc.world?.sizeCells;
  const world = res !== undefined && size !== undefined ? { wM: size.x * res, hM: size.y * res } : undefined;
  return {
    world,
    agents: agents.flatMap((a): MissionAgent[] => {
      if (a.key === undefined) return [];
      const spec = doc.agents?.find((x) => x.key === a.key);
      const body = (a.config as { body?: { sensors?: readonly { type?: string }[]; cruiseAltitudeM?: number } } | undefined)?.body;
      return [
        {
          id: a.id,
          key: a.key,
          kind: a.kind,
          facts: { kind: a.kind, airborne: a.kind === "uav" && (spec?.start?.zM ?? 0) > 0, soc: 1, hasBase: true, hasRangeSensor: (body?.sensors ?? []).some((x) => x.type !== "camera") },
          cruiseAltitudeM: body?.cruiseAltitudeM,
          start: spec?.start ? { x: spec.start.xM, y: spec.start.yM } : undefined,
          base: spec?.base ? { x: spec.base.xM, y: spec.base.yM } : undefined,
        },
      ];
    }),
  };
}
