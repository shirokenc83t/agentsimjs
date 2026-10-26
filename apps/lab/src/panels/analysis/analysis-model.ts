import { matchesRecord, type FilterAst, type TraceRecord } from "@agentsim/trace";
import { flagRole, glyphOf, markOf } from "../debug/marks.ts";

// The model of the Analysis workspace (ADR-0029): everything it draws or exports is a function of a recorded run's pose samples, records and metric samples and of one filter
// (the log console's language: one AST). Pure: the panels read the storage and draw; the numbers and the files come from here.

/** One pose sample as the recording stores it. */
export interface PoseSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly speedMps: number;
  readonly soc: number;
}

export interface Trajectory {
  readonly agentId: string;
  readonly samples: readonly PoseSample[];
}

/** The pose sample a record holds (an `observation` of the body whose op is `pose`), or undefined for any other record. */
export function poseOfRecord(r: TraceRecord): PoseSample | undefined {
  if (r.kind !== "observation") return undefined;
  const p = r.payload as { op?: unknown; x?: unknown; y?: unknown; z?: unknown; speedMps?: unknown; soc?: unknown } | null;
  if (p === null || typeof p !== "object" || p.op !== "pose" || typeof p.x !== "number" || typeof p.y !== "number") return undefined;
  return { t: r.simTime, x: p.x, y: p.y, z: typeof p.z === "number" ? p.z : 0, speedMps: typeof p.speedMps === "number" ? p.speedMps : 0, soc: typeof p.soc === "number" ? p.soc : 0 };
}

/** The trajectories of a run from its pose records: one per agent, samples in time order (records of equal time keep their sequence order). */
export function trajectoriesOf(records: readonly TraceRecord[]): Map<string, Trajectory> {
  const by = new Map<string, { sample: PoseSample; seq: number }[]>();
  for (const r of records) {
    const s = poseOfRecord(r);
    const id = r.agentId;
    if (s === undefined || id === undefined) continue;
    const list = by.get(id) ?? [];
    list.push({ sample: s, seq: r.seq });
    by.set(id, list);
  }
  const out = new Map<string, Trajectory>();
  for (const id of [...by.keys()].sort()) {
    const list = (by.get(id) as { sample: PoseSample; seq: number }[]).sort((a, b) => a.sample.t - b.sample.t || a.seq - b.seq);
    out.set(id, { agentId: id, samples: list.map((x) => x.sample) });
  }
  return out;
}

/** Where the agent was at `t`: the samples around it interpolated, clamped to its first and last sample; undefined for an agent with no sample. */
export function positionAt(tr: Trajectory, t: number): { readonly x: number; readonly y: number } | undefined {
  const s = tr.samples;
  if (s.length === 0) return undefined;
  const first = s[0] as PoseSample;
  const last = s[s.length - 1] as PoseSample;
  if (t <= first.t) return { x: first.x, y: first.y };
  if (t >= last.t) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((s[mid] as PoseSample).t <= t) lo = mid;
    else hi = mid;
  }
  const a = s[lo] as PoseSample;
  const b = s[hi] as PoseSample;
  const k = b.t - a.t < 1e-12 ? 0 : (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** The points of the trajectory inside the window, with its two ends interpolated, so a window cuts the line where it is and not at the sample before. */
export function pointsInWindow(tr: Trajectory, t0: number, t1: number): { readonly x: number; readonly y: number; readonly t: number }[] {
  const s = tr.samples;
  if (s.length === 0 || t1 < (s[0] as PoseSample).t || t0 > (s[s.length - 1] as PoseSample).t) return [];
  const out: { x: number; y: number; t: number }[] = [];
  const fromT = Math.max(t0, (s[0] as PoseSample).t);
  const from = positionAt(tr, fromT);
  if (from) out.push({ ...from, t: fromT });
  for (const p of s) if (p.t > t0 && p.t < t1) out.push({ x: p.x, y: p.y, t: p.t });
  const end = Math.min(t1, (s[s.length - 1] as PoseSample).t);
  const to = positionAt(tr, end);
  if (to && end > fromT) out.push({ ...to, t: end });
  return out;
}

export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The box the trajectories fill, or undefined when there is none. */
export function boundsOf(trs: Iterable<Trajectory>): Bounds | undefined {
  let b: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (const tr of trs)
    for (const p of tr.samples) {
      if (!b) b = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      else {
        b.x0 = Math.min(b.x0, p.x);
        b.y0 = Math.min(b.y0, p.y);
        b.x1 = Math.max(b.x1, p.x);
        b.y1 = Math.max(b.y1, p.y);
      }
    }
  return b;
}

// ---- the filter -------------------------------------------------------------------------------------------------------------------------------------------

/** The sim-time window a filter selects (the first positive `t:` term), or undefined when it has none. Open ends are infinite. */
export function windowOfFilter(ast: FilterAst): { readonly t0: number; readonly t1: number } | undefined {
  for (const t of ast.terms) {
    if (t.key !== "t" || t.negated || t.ranges.length === 0) continue;
    const r = t.ranges[0];
    if (r) return { t0: r.min, t1: r.max };
  }
  return undefined;
}

/** The agents a filter shows out of `all`: the ones its positive `agent:` terms name, minus the ones a negated term names; every agent when it has none. */
export function agentsShown(ast: FilterAst, all: readonly string[]): string[] {
  let shown = [...all];
  for (const t of ast.terms) {
    if (t.key !== "agent") continue;
    shown = t.negated ? shown.filter((a) => !t.values.includes(a)) : shown.filter((a) => t.values.includes(a));
  }
  return shown;
}

/** The records a record filter selects, in the order given. */
export function filterRecords(records: readonly TraceRecord[], ast: FilterAst): TraceRecord[] {
  return records.filter((r) => matchesRecord(ast, r));
}

// ---- markers ----------------------------------------------------------------------------------------------------------------------------------------------

/** An event on the map: where the agent was when it happened, the glyph of its kind (never colour alone: ✕ ▲ are the flags) and what it says. */
export interface MapMarker {
  readonly seq: number;
  readonly t: number;
  readonly agentId: string;
  readonly kind: string;
  readonly glyph: string;
  readonly role: "alarm" | "warning" | undefined;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

/** The ops of an action that are events on the map (the start and the end of an action and a refused start); its phases and notes are for the log. */
const ACTION_EVENTS = new Set(["start", "end", "rejected"]);

/** Whether a record is an event of the map: an action's start, end or refusal, a reflex, an injected command, a degradation. */
export function isMapEvent(r: TraceRecord): boolean {
  if (r.kind === "action") return ACTION_EVENTS.has((r.payload as { op?: string } | null)?.op ?? "");
  return r.kind === "reflex" || r.kind === "injected" || r.kind === "degradation";
}

/** The markers of the map for the records given: those of an agent with a trajectory, placed where it was; run-level records have no place on the map. */
export function markersOf(records: readonly TraceRecord[], trajectories: ReadonlyMap<string, Trajectory>): MapMarker[] {
  const out: MapMarker[] = [];
  for (const r of records) {
    if (!isMapEvent(r) || r.agentId === undefined) continue;
    const tr = trajectories.get(r.agentId);
    const at = tr ? positionAt(tr, r.simTime) : undefined;
    if (!at) continue;
    const m = markOf(r);
    const p = r.payload as { op?: string } | null;
    out.push({ seq: r.seq, t: r.simTime, agentId: r.agentId, kind: r.kind, glyph: glyphOf(m), role: flagRole(m), x: at.x, y: at.y, label: `${r.simTime.toFixed(1)} s ${r.agentId} ${r.kind}${p?.op ? ` ${p.op}` : ""}${m.status ? ` ${m.status}` : ""}${m.code ? ` · ${m.code}` : ""}` });
  }
  return out;
}

/** Plain markers in view beyond which they are thinned (the flags never are). */
export const PLAIN_MARKER_LIMIT = 400;

/**
 * The markers to draw: the flags (X, triangle) always, and the plain ones as they are when there are few; above `limit` the plain ones are thinned per pixel bin and kind (the
 * first of each bin stays), so a dense run is a texture and not a blot, and no flag is ever lost under it.
 */
export function thinMarkers(markers: readonly MapMarker[], px: (x: number) => number, py: (y: number) => number, limit = PLAIN_MARKER_LIMIT, binPx = 6): readonly MapMarker[] {
  let plain = 0;
  for (const m of markers) if (m.role === undefined) plain++;
  if (plain <= limit) return markers;
  const seen = new Set<string>();
  return markers.filter((m) => {
    if (m.role !== undefined) return true;
    const key = `${m.kind}|${Math.floor(px(m.x) / binPx)}|${Math.floor(py(m.y) / binPx)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where the labels at the right end of a chart go: each wants the y of the end of its line, and where lines end together the labels are stacked at least `gap` px apart
 * (never the data: only the text moves), kept inside [min, max]. Returns the y of each label, in the order given.
 */
export function stackedLabelYs(wanted: readonly number[], gap: number, min: number, max: number): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const ys: number[] = [];
  for (const o of order) ys.push(Math.max(min, ys.length === 0 ? o.y : Math.max(o.y, (ys[ys.length - 1] as number) + gap)));
  // Pushed past the bottom: move the pile back up from the end.
  for (let k = ys.length - 1; k >= 0; k--) {
    const limit = k === ys.length - 1 ? max : (ys[k + 1] as number) - gap;
    if ((ys[k] as number) > limit) ys[k] = limit;
  }
  const out: number[] = new Array(wanted.length).fill(0);
  order.forEach((o, k) => (out[o.i] = ys[k] as number));
  return out;
}

/** The value a series has at `t`: that of the last sample at or before it (a sample holds until the next), or the first when `t` is before them all. */
export function valueAtTime(points: readonly SeriesPoint[], t: number): number | undefined {
  if (points.length === 0) return undefined;
  let v = (points[0] as SeriesPoint).v;
  for (const p of points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

// ---- series -----------------------------------------------------------------------------------------------------------------------------------------------

export interface SeriesPoint {
  readonly t: number;
  readonly v: number;
}

/** One series of one agent, and where it comes from: a recorded `metric` or the `compute` records of the planner (there is no metric for those). */
export interface AnalysisSeries {
  readonly key: string;
  readonly agentId: string;
  readonly name: string;
  readonly unit: string;
  readonly source: "metric" | "compute";
  readonly points: readonly SeriesPoint[];
}

const METRIC_SERIES: readonly { readonly metric: string; readonly name: string; readonly unit: string }[] = [
  { metric: "agent.soc", name: "battery", unit: "fraction" },
  { metric: "agent.speedMps", name: "speed", unit: "m/s" },
];

/** The series that come from recorded metrics (battery, speed), one per agent and metric, in time order. `owner` is the agent of a sample's source (`ugv-001/body` → `ugv-001`). */
export function metricSeriesOf(samples: readonly { readonly source: string; readonly name: string; readonly simTime: number; readonly value: number; readonly tick: number }[]): AnalysisSeries[] {
  const by = new Map<string, { agentId: string; def: (typeof METRIC_SERIES)[number]; pts: { t: number; v: number; tick: number }[] }>();
  for (const s of samples) {
    const def = METRIC_SERIES.find((d) => d.metric === s.name);
    if (!def) continue;
    const agentId = s.source.split("/")[0] ?? s.source;
    const key = `${agentId}|${def.metric}`;
    const e = by.get(key) ?? { agentId, def, pts: [] };
    e.pts.push({ t: s.simTime, v: s.value, tick: s.tick });
    by.set(key, e);
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, e]) => ({ key, agentId: e.agentId, name: e.def.name, unit: e.def.unit, source: "metric" as const, points: e.pts.sort((a, b) => a.tick - b.tick).map(({ t, v }) => ({ t, v })) }));
}

/**
 * The series that have no metric: what the planner spent (`expansionsCharged`) and how long a query took (ticks from its submission to its completion), from the `compute`
 * records of the plan outcomes. One point per completed query, at the time of its record.
 */
export function computeSeriesOf(records: readonly TraceRecord[]): AnalysisSeries[] {
  const exp = new Map<string, SeriesPoint[]>();
  const lat = new Map<string, SeriesPoint[]>();
  for (const r of records) {
    if (r.kind !== "compute" || r.agentId === undefined) continue;
    const p = r.payload as { op?: unknown; expansionsCharged?: unknown; submittedTick?: unknown; completedTick?: unknown } | null;
    if (p === null || typeof p !== "object" || p.op !== "plan") continue;
    if (typeof p.expansionsCharged === "number") (exp.get(r.agentId) ?? exp.set(r.agentId, []).get(r.agentId))?.push({ t: r.simTime, v: p.expansionsCharged });
    if (typeof p.submittedTick === "number" && typeof p.completedTick === "number") (lat.get(r.agentId) ?? lat.set(r.agentId, []).get(r.agentId))?.push({ t: r.simTime, v: p.completedTick - p.submittedTick });
  }
  const out: AnalysisSeries[] = [];
  for (const id of [...exp.keys()].sort()) out.push({ key: `${id}|expansions`, agentId: id, name: "planner expansions", unit: "per query", source: "compute", points: exp.get(id) ?? [] });
  for (const id of [...lat.keys()].sort()) out.push({ key: `${id}|latency`, agentId: id, name: "planning latency", unit: "ticks", source: "compute", points: lat.get(id) ?? [] });
  return out;
}

/** The series of the given agents inside the window (the window's ends are the filter's: infinite when open). */
export function seriesInWindow(series: readonly AnalysisSeries[], agents: ReadonlySet<string>, win: { readonly t0: number; readonly t1: number } | undefined): AnalysisSeries[] {
  return series
    .filter((s) => agents.has(s.agentId))
    .map((s) => (win === undefined ? s : { ...s, points: s.points.filter((p) => p.t >= win.t0 && p.t <= win.t1) }))
    .filter((s) => s.points.length > 0);
}

// ---- exports ----------------------------------------------------------------------------------------------------------------------------------------------

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The series as CSV (RFC 4180, CRLF): one row per point, `agent,series,source,unit,t_s,value`. */
export function csvOfSeries(series: readonly AnalysisSeries[]): string {
  const rows = ["agent,series,source,unit,t_s,value"];
  for (const s of series) for (const p of s.points) rows.push([s.agentId, s.name, s.source, s.unit, p.t, p.v].map(csvCell).join(","));
  return `${rows.join("\r\n")}\r\n`;
}

/** The records as JSON lines, one record per line, in the order given. */
export function jsonlOfRecords(records: readonly TraceRecord[]): string {
  return records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// ---- the picture --------------------------------------------------------------------------------------------------------------------------------------------

/** What the top-down map draws, in world metres: the blocked cells, the trajectories and where the agents are, the events. */
export interface MapModel {
  readonly widthM: number;
  readonly heightM: number;
  /** Blocked cells of the world, row by row from y = 0 (undefined when the map is not known). */
  readonly blocked: { readonly cols: number; readonly rows: number; readonly cellM: number; readonly cells: Uint8Array } | undefined;
  /** `t` (sim seconds) is on the points that are samples of a recording: a click on the line is a moment. */
  readonly trajectories: readonly { readonly agentId: string; readonly colorIndex: number; readonly points: readonly { readonly x: number; readonly y: number; readonly t?: number }[] }[];
  readonly positions: readonly { readonly agentId: string; readonly colorIndex: number; readonly x: number; readonly y: number }[];
  readonly markers: readonly MapMarker[];
}

/** The world to screen mapping of a map `w` × `h` px with a margin: metres to pixels, y up (north at the top), the world fitted and centred. */
export function mapTransform(m: Pick<MapModel, "widthM" | "heightM">, w: number, h: number, margin = 12): { readonly scale: number; readonly ox: number; readonly oy: number; px: (x: number) => number; py: (y: number) => number } {
  const scale = Math.max(1e-9, Math.min((w - 2 * margin) / Math.max(1e-9, m.widthM), (h - 2 * margin) / Math.max(1e-9, m.heightM)));
  const ox = (w - m.widthM * scale) / 2;
  const oy = (h - m.heightM * scale) / 2;
  return { scale, ox, oy, px: (x) => ox + x * scale, py: (y) => h - oy - y * scale };
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Colours the SVG needs as values (a file has no stylesheet): the page resolves its tokens and passes them. */
export interface MapPalette {
  /** The grey of the agents that are not the subject (ADR-0043 §3); the map on screen uses it, the exported SVG does not. */
  readonly muted?: string;
  readonly background: string;
  readonly obstacle: string;
  readonly text: string;
  readonly alarm: string;
  readonly warning: string;
  readonly agent: readonly string[];
  /** The colour of each kind family (slate, violet, ...) as a value: the plain markers of the map are drawn in it. */
  readonly kind?: Readonly<Record<string, string>>;
}

/** The map as a standalone SVG document (well-formed XML): obstacles, trajectories, positions and events; every marker has its text as a title. */
export function buildMapSvg(m: MapModel, palette: MapPalette, width = 900): string {
  const height = Math.max(1, Math.round((width * m.heightM) / Math.max(1e-9, m.widthM)));
  const k = width / Math.max(1e-9, m.widthM);
  const X = (x: number) => (x * k).toFixed(2);
  const Y = (y: number) => (height - y * k).toFixed(2);
  const agent = (i: number) => palette.agent[((i % palette.agent.length) + palette.agent.length) % palette.agent.length] ?? palette.text;
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="monospace" font-size="11">`, `<rect width="${width}" height="${height}" fill="${palette.background}"/>`];
  if (m.blocked) {
    const { cols, rows, cellM, cells } = m.blocked;
    const rects: string[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; ) {
        if (!cells[j * cols + i]) {
          i++;
          continue;
        }
        let e = i;
        while (e < cols && cells[j * cols + e]) e++;
        rects.push(`<rect x="${X(i * cellM)}" y="${Y((j + 1) * cellM)}" width="${((e - i) * cellM * k).toFixed(2)}" height="${(cellM * k).toFixed(2)}"/>`);
        i = e;
      }
    }
    parts.push(`<g fill="${palette.obstacle}">${rects.join("")}</g>`);
  }
  for (const t of m.trajectories) {
    if (t.points.length < 2) continue;
    parts.push(`<polyline fill="none" stroke="${agent(t.colorIndex)}" stroke-width="1.5" data-agent="${esc(t.agentId)}" points="${t.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}"/>`);
  }
  for (const p of m.positions) parts.push(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="${agent(p.colorIndex)}" data-agent="${esc(p.agentId)}"><title>${esc(p.agentId)}</title></circle>`);
  for (const mk of m.markers) {
    const fill = mk.role === "alarm" ? palette.alarm : mk.role === "warning" ? palette.warning : palette.text;
    parts.push(`<text x="${X(mk.x)}" y="${Y(mk.y)}" fill="${fill}" text-anchor="middle" dominant-baseline="central" data-seq="${mk.seq}"><title>${esc(mk.label)}</title>${esc(mk.glyph)}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
