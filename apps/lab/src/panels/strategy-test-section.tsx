import { PLANNING_STRATEGY_PRESETS, type PlanningEntry, type StrategyTestResult } from "@agentsim/scenarios";
import { STATE_GLYPH } from "@agentsim/ui";
import Button from "@mui/material/Button";
import { useEffect, useRef, useState } from "react";
import { parseInlineStrategy } from "./run-config/model.ts";
import type { RunSource } from "../sim/run-source.ts";
import { QueryDetail } from "./plan-query-table.tsx";
import { asResearcherPlan } from "./researcher-data.ts";
import { RESEARCHER_BANNER } from "./researcher-section.tsx";
import { sandboxTarget, sandboxView, useSandboxTarget } from "./sandbox-store.ts";
import { sandboxRow } from "./stage-lines.ts";

const OWN = "own";
const INLINE = "inline";
const presetKey = (p: { readonly id: string; readonly version: number }) => `${p.id}@${p.version}`;

function pathLengthM(w: readonly (readonly [number, number])[]): number {
  let l = 0;
  for (let k = 1; k < w.length; k++) l += Math.hypot((w[k]?.[0] ?? 0) - (w[k - 1]?.[0] ?? 0), (w[k]?.[1] ?? 0) - (w[k - 1]?.[1] ?? 0));
  return l;
}

const num = (t: string): number | undefined => (t.trim() === "" || !Number.isFinite(Number(t)) ? undefined : Number(t));

/**
 * Strategy test (ADR-0037 seventh addition, item 16; researcher tool): plan from the selected agent's current position to a
 * target with a strategy of your choice, on its belief map as it is now (a snapshot copy: "what this agent would plan") or on
 * the ground truth, without touching the run: a separate planner in the worker, no run id, no trace record, no effect on any
 * hash. A result on the ground truth is observer data: marked, with the researcher banner, like the beliefs-versus-truth
 * view. The result is drawn in the Scene in a tone of its own.
 */
export function StrategyTestSection(props: { source: Pick<RunSource, "strategyTest">; agentId: string }) {
  const { source, agentId } = props;
  const [choice, setChoice] = useState(OWN);
  const [inline, setInline] = useState("");
  const [map, setMap] = useState<"belief" | "truth">("belief");
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; path?: string | undefined } | undefined>(undefined);
  const [result, setResult] = useState<StrategyTestResult | undefined>(undefined);
  const latest = useRef(0);
  const picked = useSandboxTarget();

  // A target picked in the Scene fills the fields.
  useEffect(() => {
    if (picked.target) {
      setX(String(Math.round(picked.target.xM * 100) / 100));
      setY(String(Math.round(picked.target.yM * 100) / 100));
    }
  }, [picked.target]);
  // Leaving the section (another agent, the Inspector closing) takes its result and its pick gesture out of the Scene.
  useEffect(
    () => () => {
      sandboxView.set(undefined);
      sandboxTarget.cancelPicking();
    },
    [],
  );

  const parsed = choice === INLINE ? parseInlineStrategy(inline) : undefined;
  const strategy: PlanningEntry["strategy"] | undefined =
    choice === OWN ? undefined : choice === INLINE ? (parsed?.ok ? parsed.value : undefined) : (() => {
      const p = PLANNING_STRATEGY_PRESETS.find((q) => presetKey(q) === choice);
      return p ? { ref: p.id, version: p.version } : undefined;
    })();
  const tx = num(x);
  const ty = num(y);
  const canRun = !pending && tx !== undefined && ty !== undefined && (choice !== INLINE || parsed?.ok === true);

  const run = () => {
    if (tx === undefined || ty === undefined) return;
    const id = ++latest.current;
    setPending(true);
    setError(undefined);
    void source.strategyTest({ agentId, to: { xM: tx, yM: ty }, planOn: map, ...(strategy === undefined ? {} : { strategy }) }).then((m) => {
      if (id !== latest.current) return; // a newer request owns the section
      setPending(false);
      if (!m.ok || m.result === undefined) {
        setResult(undefined);
        sandboxView.set(undefined);
        setError(m.error ?? { code: "no_result", message: "the worker sent no result" });
        return;
      }
      const r = m.result as StrategyTestResult;
      setResult(r);
      sandboxView.set({ agentId, result: r.map === "truth" ? asResearcherPlan(r) : r });
    });
  };
  const clear = () => {
    latest.current++;
    setPending(false);
    setResult(undefined);
    setError(undefined);
    sandboxView.set(undefined);
  };

  const state = result ? (result.status === "found" ? "ok" : "alm") : undefined;
  return (
    <section className="inspector-section" data-testid="inspector-strategy-test">
      <h4>Strategy test (researcher tool)</h4>
      <p className="muted">Plans apart from the run: no trace, no run input, no effect on any hash.</p>
      <div className="row wrap">
        <label className="field">
          <span className="field-label">strategy</span>
          <select className="mono" value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Strategy to test" data-testid="st-strategy">
            <option value={OWN}>the agent&apos;s own planner</option>
            {PLANNING_STRATEGY_PRESETS.map((p) => (
              <option key={presetKey(p)} value={presetKey(p)}>
                {p.id} · v{p.version}
              </option>
            ))}
            <option value={INLINE}>inline JSON…</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">map</span>
          <select className="mono" value={map} onChange={(e) => setMap(e.target.value === "truth" ? "truth" : "belief")} aria-label="Map to plan on" data-testid="st-map">
            <option value="belief">the agent&apos;s belief map (snapshot)</option>
            <option value="truth">◆ the ground truth (researcher)</option>
          </select>
        </label>
      </div>
      {map === "truth" && (
        <p className="researcher-banner" role="note" data-testid="st-researcher-banner">
          ◆ {RESEARCHER_BANNER}
        </p>
      )}
      {choice === INLINE && (
        <>
          <textarea className="mono" rows={8} value={inline} onChange={(e) => setInline(e.target.value)} spellCheck={false} aria-label="Strategy JSON" data-testid="st-json" style={{ width: "100%" }} />
          {parsed && !parsed.ok && (
            <p className="danger issue" role="alert" data-testid="st-json-error">
              ✕ <span className="mono">{parsed.code}</span> {parsed.message}
            </p>
          )}
        </>
      )}
      <div className="row wrap">
        <label className="field">
          <span className="field-label">target x (m)</span>
          <input className="mono" style={{ width: "6em" }} value={x} onChange={(e) => setX(e.target.value)} inputMode="decimal" aria-label="target x (m)" data-testid="st-x" />
        </label>
        <label className="field">
          <span className="field-label">y (m)</span>
          <input className="mono" style={{ width: "6em" }} value={y} onChange={(e) => setY(e.target.value)} inputMode="decimal" aria-label="target y (m)" data-testid="st-y" />
        </label>
        <Button size="small" variant="outlined" color="inherit" onClick={() => (picked.picking ? sandboxTarget.cancelPicking() : sandboxTarget.startPicking())} aria-pressed={picked.picking} data-testid="st-pick">
          {picked.picking ? "Click a target in the Scene · Esc" : "Pick on the map"}
        </Button>
        <Button size="small" variant="contained" disabled={!canRun} onClick={run} data-testid="st-run">
          {pending ? "Planning…" : "Test"}
        </Button>
        <Button size="small" variant="text" color="inherit" disabled={result === undefined && error === undefined} onClick={clear} data-testid="st-clear">
          Clear
        </Button>
      </div>
      {picked.picking && <p className="muted">Click a target in the Scene (Esc cancels).</p>}
      {error && (
        <p className="danger issue" role="alert" data-testid="st-error">
          ✕ <span className="mono">{error.code}</span> {error.message}
          {error.path && <span className="muted mono"> at {error.path}</span>}
        </p>
      )}
      {result && state && (
        <div data-testid="st-result">
          <p className={`mono st-${state}`} data-testid="st-status">
            {STATE_GLYPH[state]} {result.status} · {result.planner} · {result.ticks} ticks · {result.expansionsCharged} expansions
            {result.status === "found" ? ` · ${pathLengthM(result.waypoints).toFixed(1)} m` : ""}
          </p>
          <p className="muted" data-testid="st-source">
            planned on {result.map === "truth" ? "the ground truth" : "the agent's belief map as it was when you pressed Test"}
          </p>
          {result.map === "truth" && (
            <p className="researcher-banner" role="note" data-testid="st-result-researcher">
              ◆ {RESEARCHER_BANNER}
            </p>
          )}
          <QueryDetail row={sandboxRow(agentId, result)} />
        </div>
      )}
    </section>
  );
}
