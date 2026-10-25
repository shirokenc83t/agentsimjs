import "../panels.css";
import { identityOf, shortLabel } from "@agentsim/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { stackedLabelYs, valueAtTime, type AnalysisSeries } from "./analysis-model.ts";

export interface AnalysisSeriesProps {
  readonly series: readonly AnalysisSeries[];
  /** The index of an agent in the run: its colour and marker style are its identity's. */
  readonly indexOf: (agentId: string) => number;
  /** The span drawn, in sim seconds (the window, or the run). */
  readonly span: { readonly t0: number; readonly t1: number };
  readonly cursorS: number;
  /** The agent the panels are looking at: its line is drawn heavier and the others dimmer. */
  readonly selectedAgent?: string | undefined;
  readonly onSeek: (tS: number, agentId?: string) => void;
}

const PAD = { l: 52, r: 78, t: 6, b: 16 };
const ROW_H = 92;
const LABEL_GAP = 11;
/** More lines than this get end labels for the selected agent and the first few only, and the legend under the chart lists every one (it scrolls). */
const END_LABELS = 6;

const fmt = (v: number): string => (Math.abs(v) >= 1000 ? String(Math.round(v)) : Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(1) : String(Math.round(v * 100) / 100));

/** Where a series comes from, in words (the review of an analysis starts with what a number is made of). */
const sourceNote = (s: AnalysisSeries): string => (s.source === "metric" ? (s.name === "battery" ? "recorded metric agent.soc" : "recorded metric agent.speedMps") : "from the planner's compute records (no metric for it)");

/**
 * The per-agent time series of the Analysis workspace: battery and speed (recorded metrics), planner expansions and planning latency (the planner's `compute` records, which
 * is said under each title). One chart per quantity, one line per agent in its colour, the shared cursor drawn on it, a click on it moves the cursor. Lines that end together
 * are told apart by labels at the right edge (stacked, never moved data), a hover reads every agent's value at that moment, and the selected agent's line is the heavy one.
 * Fractions (the battery) are on a 0 to 1 axis. In pixels, so its text keeps the size of the chrome's.
 */
export function AnalysisSeriesView(props: AnalysisSeriesProps) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<{ chart: string; t: number } | undefined>(undefined);
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
        const first = lines[0] as AnalysisSeries;
        let lo = Infinity;
        let hi = -Infinity;
        for (const l of lines)
          for (const p of l.points) {
            lo = Math.min(lo, p.v);
            hi = Math.max(hi, p.v);
          }
        // Lines that never move (every agent at one value the whole run, or one sample) take one line, not a plot: the value and how long it held; the room goes to the charts that say something.
        if (hi - lo < 1e-9 && lo !== Infinity) {
          const value = first.unit === "fraction" ? lo.toFixed(2) : fmt(lo);
          const who = lines.length === 1 ? shortLabel((lines[0] as AnalysisSeries).agentId) : `${lines.length} agents`;
          return (
            <figure key={name} className="asv-chart asv-flat" data-testid={`series-${name.replace(/\s+/g, "-")}`} data-flat="true">
              <figcaption className="mono">
                <b>{name}</b>: <span data-testid={`series-flat-${name.replace(/\s+/g, "-")}`}>{value}</span> <span className="muted">all run · {first.unit} · {who} · {sourceNote(first)}</span>
              </figcaption>
            </figure>
          );
        }
        // A fraction is on its natural axis, 0 to 1, whatever part of it the lines use; any other quantity on the range of its data.
        if (first.unit === "fraction") [lo, hi] = [0, 1];
        // One value (a single sample, or lines that never move): the axis is that value plus and minus one, and the value is written once, in the middle.
        const flat = first.unit !== "fraction" && hi - lo < 1e-9;
        const flatValue = lo;
        if (flat) [lo, hi] = [lo - 1, hi + 1];
        const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (ROW_H - PAD.t - PAD.b);
        const allEnds = lines.flatMap((l) => {
          const last = l.points[l.points.length - 1];
          return last === undefined ? [] : [{ line: l, v: last.v, y: y(last.v) }];
        });
        // Many lines: labels at the ends for the selected agent and the first few; the rest are in the legend under the chart.
        const crowded = allEnds.length > END_LABELS;
        const ends = crowded
          ? [...allEnds.filter((e) => e.line.agentId === props.selectedAgent), ...allEnds.filter((e) => e.line.agentId !== props.selectedAgent)].slice(0, END_LABELS).sort((a, b) => allEnds.indexOf(a) - allEnds.indexOf(b))
          : allEnds;
        const labelYs = stackedLabelYs(ends.map((e) => e.y), LABEL_GAP, PAD.t + 5, ROW_H - PAD.b - 2);
        const hv = hover?.chart === name ? hover.t : undefined;
        const readout = hv === undefined ? undefined : lines.flatMap((l) => {
          const v = valueAtTime(l.points, hv);
          return v === undefined ? [] : [{ agentId: l.agentId, v }];
        });
        const testName = name.replace(/\s+/g, "-");
        return (
          <figure key={name} className="asv-chart" data-testid={`series-${testName}`}>
            <figcaption className="mono">
              <b>{name}</b> <span className="muted">{first.unit} · {sourceNote(first)}</span>
              {readout !== undefined && (
                <span className="asv-read" data-testid={`series-read-${testName}`}>
                  {" "}
                  · at {hv?.toFixed(1)} s:
                  {readout.map((r) => (
                    <span key={r.agentId} style={{ color: `var(--agent-${identityOf(props.indexOf(r.agentId)).colorIndex})` }}>
                      {" "}
                      {shortLabel(r.agentId)} {fmt(r.v)}
                    </span>
                  ))}
                </span>
              )}
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
              onPointerMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const t = t0 + ((e.clientX - r.left - PAD.l) / (w - PAD.l - PAD.r)) * (t1 - t0);
                setHover(t >= t0 && t <= t1 ? { chart: name, t } : undefined);
              }}
              onPointerLeave={() => setHover(undefined)}
            >
              <line className="axis" x1={PAD.l} y1={ROW_H - PAD.b} x2={w - PAD.r} y2={ROW_H - PAD.b} />
              <line className="axis" x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={ROW_H - PAD.b} />
              {flat ? (
                <text className="tick" x={4} y={(PAD.t + ROW_H - PAD.b) / 2 + 3} data-testid={`series-flat-${testName}`}>{fmt(flatValue)}</text>
              ) : (
                <>
                  <text className="tick" x={4} y={PAD.t + 8}>{fmt(hi)}</text>
                  <text className="tick" x={4} y={ROW_H - PAD.b}>{fmt(lo)}</text>
                </>
              )}
              <text className="tick" x={PAD.l} y={ROW_H - 3}>{t0.toFixed(1)} s</text>
              <text className="tick" x={w - PAD.r} y={ROW_H - 3} textAnchor="end">{t1.toFixed(1)} s</text>
              {lines.map((l) => {
                const dim = props.selectedAgent !== undefined && props.selectedAgent !== l.agentId;
                return (
                  <polyline
                    key={l.key}
                    className={`line${props.selectedAgent === l.agentId ? " sel" : ""}${dim ? " dim" : ""}`}
                    data-agent={l.agentId}
                    style={{ stroke: `var(--agent-${identityOf(props.indexOf(l.agentId)).colorIndex})` }}
                    points={l.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
                  />
                );
              })}
              {ends.map((e, i) => (
                <g key={e.line.key} className={`end${props.selectedAgent !== undefined && props.selectedAgent !== e.line.agentId ? " dim" : ""}`} data-testid={`series-end-${testName}-${e.line.agentId}`}>
                  <rect x={w - PAD.r + 6} y={(labelYs[i] as number) - 4} width={7} height={7} style={{ fill: `var(--agent-${identityOf(props.indexOf(e.line.agentId)).colorIndex})` }} />
                  <text className="tick" x={w - PAD.r + 16} y={(labelYs[i] as number) + 3}>{shortLabel(e.line.agentId)} {fmt(e.v)}</text>
                </g>
              ))}
              {props.cursorS >= t0 && props.cursorS <= t1 && <line className="cursor" x1={x(props.cursorS)} y1={PAD.t} x2={x(props.cursorS)} y2={ROW_H - PAD.b} />}
              {hv !== undefined && <line className="hover" x1={x(hv)} y1={PAD.t} x2={x(hv)} y2={ROW_H - PAD.b} />}
            </svg>
            {crowded && (
              <ul className="asv-legend mono" data-testid={`series-legend-${testName}`} aria-label={`${name}: every agent and its last value`}>
                {allEnds.map((e) => (
                  <li key={e.line.key} className={props.selectedAgent === e.line.agentId ? "sel" : undefined}>
                    <span className="sw" style={{ background: `var(--agent-${identityOf(props.indexOf(e.line.agentId)).colorIndex})` }} /> {shortLabel(e.line.agentId)} <span className="muted">{fmt(e.v)}</span>
                  </li>
                ))}
              </ul>
            )}
          </figure>
        );
      })}
    </div>
  );
}
