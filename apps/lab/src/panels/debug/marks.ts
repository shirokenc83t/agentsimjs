import type { TraceRecord } from "@agentsim/trace";

/** One mark on a lane of the Timeline: what happened to an agent (or to the run) and when. */
export interface Mark {
  readonly seq: number;
  /** Sim time in seconds. */
  readonly t: number;
  readonly kind: string;
  /** The record's `op`, when it has one (`start`, `end`, `checkpoint`…). */
  readonly op: string | undefined;
  /** The agent it is about; undefined for the run's own marks (snapshots, checkpoints, degradations). */
  readonly agentId: string | undefined;
  /** How an action ended (`succeeded`, `failed`, `preempted`), on the record that ends it. */
  readonly status?: string | undefined;
}

/** The kinds the Timeline marks (actions, reflexes, injected commands, degradations, snapshots); checkpoints are `event` records with op `checkpoint`. */
export const MARK_KINDS = ["action", "reflex", "injected", "degradation", "snapshot"] as const;

export function markOf(r: TraceRecord): Mark {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown; status?: unknown }) : {};
  const status = r.kind === "action" && p.op === "end" && typeof p.status === "string" ? p.status : undefined;
  return { seq: r.seq, t: r.simTime, kind: r.kind, op: typeof p.op === "string" ? p.op : undefined, agentId: r.agentId, ...(status === undefined ? {} : { status }) };
}

/** An action that ended in failure: the mark that is a flag (UI-SPEC §6). */
export const isFailure = (m: Mark): boolean => m.status === "failed";

/** The glyph of a mark, one per meaning (ADR-0042 §4): a failure is ✕, a reflex ▲; the others by kind, in the kind's hue. */
export function glyphOf(m: Mark): string {
  if (isFailure(m)) return "✕";
  if (m.kind === "reflex") return "▲";
  if (m.kind === "injected") return "◆";
  if (m.kind === "degradation") return "▼";
  if (m.kind === "snapshot") return "◇";
  if (m.kind === "event") return "│"; // a checkpoint
  return "▪";
}

/** The legend of the glyphs, in the Timeline's title bar. `kind` names the hue (a trace kind), `alm` the alarm colour of a failure. */
export const MARK_LEGEND: readonly { readonly glyph: string; readonly name: string; readonly kind: string }[] = [
  { glyph: "▪", name: "action", kind: "action" },
  { glyph: "✕", name: "failure", kind: "alm" },
  { glyph: "▲", name: "reflex", kind: "reflex" },
  { glyph: "◆", name: "command", kind: "injected" },
  { glyph: "▼", name: "degraded", kind: "degradation" },
  { glyph: "◇", name: "snapshot", kind: "snapshot" },
];

/** What the lanes draw: marks of one lane that fall within `mergePx` of each other become one, with a count; the one shown is the most telling of them. */
export interface MarkCluster {
  readonly lane: number;
  /** Position along the track (px) of the first mark of the cluster. */
  readonly px: number;
  readonly t: number;
  readonly count: number;
  readonly shown: Mark;
}

const rank = (m: Mark): number => (isFailure(m) ? 3 : m.kind === "reflex" ? 2 : m.kind === "degradation" || m.kind === "injected" ? 1 : 0);

export function collapseMarks(marks: readonly Mark[], lanes: readonly string[], scaleS: number, trackPx: number, mergePx: number): MarkCluster[] {
  const out: MarkCluster[] = [];
  const open = new Map<number, { cluster: { lane: number; px: number; t: number; count: number; shown: Mark }; lastPx: number }>();
  for (const m of [...marks].sort((a, b) => a.t - b.t || a.seq - b.seq)) {
    const lane = laneIndex(lanes, m);
    const px = (m.t / scaleS) * trackPx;
    const cur = open.get(lane);
    if (cur && px - cur.lastPx <= mergePx) {
      cur.cluster.count++;
      cur.lastPx = px;
      if (rank(m) > rank(cur.cluster.shown)) cur.cluster.shown = m;
    } else {
      const cluster = { lane, px, t: m.t, count: 1, shown: m };
      open.set(lane, { cluster, lastPx: px });
      out.push(cluster);
    }
  }
  return out;
}

/** The lane a mark goes on: the agent's, or the run lane (`undefined` agent → index 0 of `lanes`, which starts with the run). */
export function laneIndex(lanes: readonly string[], m: Mark): number {
  if (m.agentId === undefined) return 0;
  const i = lanes.indexOf(m.agentId);
  return i < 0 ? 0 : i;
}

/** The mark of `lane` nearest to time `t` within `toleranceS`, or undefined: what a click on a lane picks. */
export function nearestMark(marks: readonly Mark[], lanes: readonly string[], lane: number, t: number, toleranceS: number): Mark | undefined {
  let best: Mark | undefined;
  let bestD = toleranceS;
  for (const m of marks) {
    if (laneIndex(lanes, m) !== lane) continue;
    const d = Math.abs(m.t - t);
    if (d <= bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}
