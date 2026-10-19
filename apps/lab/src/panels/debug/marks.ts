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
}

/** The kinds the Timeline marks (actions, reflexes, injected commands, degradations, snapshots); checkpoints are `event` records with op `checkpoint`. */
export const MARK_KINDS = ["action", "reflex", "injected", "degradation", "snapshot"] as const;

export function markOf(r: TraceRecord): Mark {
  const op = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown }).op : undefined;
  return { seq: r.seq, t: r.simTime, kind: r.kind, op: typeof op === "string" ? op : undefined, agentId: r.agentId };
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
