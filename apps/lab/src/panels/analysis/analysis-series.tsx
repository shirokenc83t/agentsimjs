import "../panels.css";
import { identityOf } from "@agentsim/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisSeries } from "./analysis-model.ts";

export interface AnalysisSeriesProps {
  readonly series: readonly AnalysisSeries[];
  /** The index of an agent in the run: its colour and marker style are its identity's. */
  readonly indexOf: (agentId: string) => number;
  /** The span drawn, in sim seconds (the window, or the run). */
  readonly span: { readonly t0: number; readonly t1: number };
  readonly cursorS: number;
  readonly onSeek: (tS: number, agentId?: string) => void;
}

const PAD = { l: 52, r: 8, t: 6, b: 16 };
const ROW_H = 92;

// Whole numbers from 1,000 up (an axis of 7.3e+3 at both ends says nothing); exponents only for the very small.
const fmt = (v: number): string => (Math.abs(v) >= 1000 ? String(Math.round(v)) : Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(1) : String(Math.round(v * 100) / 100));

/** Where a series comes from, in words (the review of an analysis starts with what a number is made of). */
const sourceNote = (s: AnalysisSeries): string => (s.source === "metric" ? (s.name === "battery" ? "recorded metric agent.soc" : "recorded metric agent.speedMps") : "from the planner's compute records (no metric for it)");

/**
 * The per-agent time series of the Analysis workspace: battery and speed (recorded metrics), planner expansions and planning latency (the planner's `compute` records, which
 * is said under each title). One chart per quantity, one line per agent in its colour, the shared cursor drawn on it, a click on it moves the cursor. In pixels, so its text
 * keeps the size of the chrome's.
 */
export function AnalysisSeriesView(props: AnalysisSeriesProps) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(260, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const groups = useMemo(() => {
    const by = new Map<string, AnalysisSeries[]>();
    for (const s of props.series) by.set(s.name, [...(by.get(s.name) ?? []), s]);
    return [...by.entries()];
  }, [props.series]);
  const t0 = props.span.t0;
  const t1 = Math.max(props.span.t1, t0 + 1e-6);
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r);
  return (
    <div ref={box} className="asv" data-testid="analysis-series" data-groups={groups.length}>
      {groups.length === 0 && <p className="muted asv-empty">No series for these agents in this window.</p>}
      {groups.map(([name, lines]) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const l of lines)
          for (const p of l.points) {
            lo = Math.min(lo, p.v);
            hi = Math.max(hi, p.v);
          }
        if (hi - lo < 1e-9) [lo, hi] = [lo - 0.5, hi + 0.5];
        const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (ROW_H - PAD.t - PAD.b);
        const first = lines[0] as AnalysisSeries;
        return (
          <figure key={name} className="asv-chart" data-testid={`series-${name.replace(/\s+/g, "-")}`}>
            <figcaption className="mono">
              <b>{name}</b> <span className="muted">{first.unit} · {sourceNote(first)}</span>
            </figcaption>
            <svg
              viewBox={`0 0 ${w} ${ROW_H}`}
              width={w}
              height={ROW_H}
              role="img"
              aria-label={`${name} over time, one line per agent`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const t = t0 + ((e.clientX - r.left - PAD.l) / (w - PAD.l - PAD.r)) * (t1 - t0);
                if (t >= t0 && t <= t1) props.onSeek(Math.round(t * 10) / 10);
              }}
            >
              <line className="axis" x1={PAD.l} y1={ROW_H - PAD.b} x2={w - PAD.r} y2={ROW_H - PAD.b} />
              <line className="axis" x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={ROW_H - PAD.b} />
              <text className="tick" x={4} y={PAD.t + 8}>{fmt(hi)}</text>
              <text className="tick" x={4} y={ROW_H - PAD.b}>{fmt(lo)}</text>
              <text className="tick" x={PAD.l} y={ROW_H - 3}>{t0.toFixed(1)} s</text>
              <text className="tick" x={w - PAD.r} y={ROW_H - 3} textAnchor="end">{t1.toFixed(1)} s</text>
              {lines.map((l) => (
                <polyline key={l.key} className="line" data-agent={l.agentId} style={{ stroke: `var(--agent-${identityOf(props.indexOf(l.agentId)).colorIndex})` }} points={l.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} />
              ))}
              {props.cursorS >= t0 && props.cursorS <= t1 && <line className="cursor" x1={x(props.cursorS)} y1={PAD.t} x2={x(props.cursorS)} y2={ROW_H - PAD.b} />}
            </svg>
          </figure>
        );
      })}
    </div>
  );
}
