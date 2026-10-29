import "../panels.css";
import { identityOf, shortLabel, subjectColor } from "@agentsim/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { stackedLabelYs, valueAtTime, type AnalysisSeries, type SeriesPoint } from "./analysis-model.ts";

/** How near a click must be to a point (px) to mark it rather than move the cursor. */
const MARK_PX = 14;

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
  /** A click on a point of a line marks it, for provenance (T-103): the point and its series. A click that is not near a point still seeks. */
  readonly onMark?: ((series: AnalysisSeries, point: SeriesPoint) => void) | undefined;
  /** The marked point (accent ring, dashed drop line and its value). */
  readonly marked?: { readonly key: string; readonly t: number; readonly v: number } | undefined;
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
                    <span key={r.agentId} style={{ color: subjectColor(identityOf(props.indexOf(r.agentId)).colorIndex, props.selectedAgent, r.agentId) }}>
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
                if (props.onMark) {
                  // The nearest point of any line of this chart, in pixels (the subject's line wins a tie).
                  const cx = e.clientX - r.left;
                  const cy = e.clientY - r.top;
                  let best: { line: AnalysisSeries; p: SeriesPoint; d: number } | undefined;
                  for (const l of lines)
                    for (const p of l.points) {
                      const d = Math.hypot(x(p.t) - cx, y(p.v) - cy) - (l.agentId === props.selectedAgent ? 0.5 : 0);
                      if (best === undefined || d < best.d) best = { line: l, p, d };
                    }
                  if (best !== undefined && best.d <= MARK_PX) {
                    props.onMark(best.line, best.p);
                    return;
                  }
                }
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
                    style={{ stroke: subjectColor(identityOf(props.indexOf(l.agentId)).colorIndex, props.selectedAgent, l.agentId) }}
                    points={l.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
                  />
                );
              })}
              {ends.map((e, i) => (
                <g key={e.line.key} className={`end${props.selectedAgent !== undefined && props.selectedAgent !== e.line.agentId ? " dim" : ""}`} data-testid={`series-end-${testName}-${e.line.agentId}`}>
                  <rect x={w - PAD.r + 6} y={(labelYs[i] as number) - 4} width={7} height={7} style={{ fill: subjectColor(identityOf(props.indexOf(e.line.agentId)).colorIndex, props.selectedAgent, e.line.agentId) }} />
                  <text className="tick" x={w - PAD.r + 16} y={(labelYs[i] as number) + 3}>{shortLabel(e.line.agentId)} {fmt(e.v)}</text>
                </g>
              ))}
              {props.marked !== undefined && lines.some((l) => l.key === props.marked?.key) && props.marked.t >= t0 && props.marked.t <= t1 && (
                <g className="mark" data-testid={`series-mark-${testName}`}>
                  <line className="drop" x1={x(props.marked.t)} y1={y(props.marked.v)} x2={x(props.marked.t)} y2={ROW_H - PAD.b} />
                  <circle cx={x(props.marked.t)} cy={y(props.marked.v)} r={5} />
                  <text className="tick" x={Math.min(x(props.marked.t) + 8, w - PAD.r - 40)} y={Math.max(PAD.t + 8, y(props.marked.v) - 8)}>{fmt(props.marked.v)}</text>
                </g>
              )}
              {props.cursorS >= t0 && props.cursorS <= t1 && <line className="cursor" x1={x(props.cursorS)} y1={PAD.t} x2={x(props.cursorS)} y2={ROW_H - PAD.b} />}
              {hv !== undefined && <line className="hover" x1={x(hv)} y1={PAD.t} x2={x(hv)} y2={ROW_H - PAD.b} />}
            </svg>
            {crowded && <SeriesLegend ends={allEnds} selected={props.selectedAgent} indexOf={props.indexOf} fmt={fmt} name={name} testName={testName} />}
          </figure>
        );
      })}
    </div>
  );
}

interface LegendEnd {
  readonly line: { readonly key: string; readonly agentId: string };
  readonly v: number;
}

/**
 * The legend of a crowded chart. With no subject it lists every agent and its last value. With a subject (one subject, one hue) it says the subject's value and the others as a range, and the
 * full list is behind "all": the others are grey and a list of twenty of them under every chart says nothing.
 */
function SeriesLegend(props: { ends: readonly LegendEnd[]; selected: string | undefined; indexOf: (id: string) => number; fmt: (v: number) => string; name: string; testName: string }) {
  const { ends, selected, fmt } = props;
  const [all, setAll] = useState(false);
  const subject = selected === undefined ? undefined : ends.find((e) => e.line.agentId === selected);
  const list = (
    <ul className="asv-legend mono" data-testid={`series-legend-${props.testName}`} aria-label={`${props.name}: every agent and its last value`}>
      {ends.map((e) => (
        <li key={e.line.key} className={selected === e.line.agentId ? "sel" : undefined}>
          <span className="sw" style={{ background: subjectColor(identityOf(props.indexOf(e.line.agentId)).colorIndex, selected, e.line.agentId) }} /> {shortLabel(e.line.agentId)} <span className="muted">{fmt(e.v)}</span>
        </li>
      ))}
    </ul>
  );
  if (subject === undefined) return list;
  const others = ends.filter((e) => e !== subject).map((e) => e.v);
  return (
    <div className="asv-subject mono" data-testid={`series-subject-${props.testName}`}>
      <span className="sw" style={{ background: subjectColor(identityOf(props.indexOf(subject.line.agentId)).colorIndex, selected, subject.line.agentId) }} /> <b>{shortLabel(subject.line.agentId)}</b> {fmt(subject.v)}
      {others.length > 0 && (
        <span className="muted">
          {" "}
          · {others.length} other{others.length === 1 ? "" : "s"} · {fmt(Math.min(...others))}–{fmt(Math.max(...others))}
        </span>
      )}{" "}
      <button type="button" className="kt" aria-expanded={all} onClick={() => setAll((o) => !o)} data-testid={`series-all-${props.testName}`}>
        {all ? "▾ all" : "▸ all"}
      </button>
      {all && list}
    </div>
  );
}
