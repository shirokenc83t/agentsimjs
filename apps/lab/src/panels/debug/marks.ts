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
  /** The failure code of a failed action or a rejected start, or the code of a reflex. */
  readonly code?: string | undefined;
}

/** The kinds the Timeline marks (actions, reflexes, injected commands, degradations, snapshots); checkpoints are `event` records with op `checkpoint`. */
export const MARK_KINDS = ["action", "reflex", "injected", "degradation", "snapshot"] as const;

export function markOf(r: TraceRecord): Mark {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown; status?: unknown; code?: unknown; failure?: { code?: unknown } }) : {};
  const status = r.kind === "action" && p.op === "end" && typeof p.status === "string" ? p.status : undefined;
  const code = r.kind === "reflex" ? p.code : r.kind === "action" && (p.op === "end" || p.op === "rejected") ? p.failure?.code : undefined;
  return {
    seq: r.seq,
    t: r.simTime,
    kind: r.kind,
    op: typeof p.op === "string" ? p.op : undefined,
    agentId: r.agentId,
    ...(status === undefined ? {} : { status }),
    ...(typeof code === "string" ? { code } : {}),
  };
}

/** An action that ended in failure: the mark that is a flag (UI-SPEC §6). */
export const isFailure = (m: Mark): boolean => m.status === "failed";

/** A start that was refused. */
export const isRejection = (m: Mark): boolean => m.kind === "action" && m.op === "rejected";

/** The marks that are flags: failures, reflexes and rejections draw in their role colour at the full height of their lane (attention.md section 3). */
export const flagRole = (m: Mark): "alarm" | "warning" | undefined => (isFailure(m) ? "alarm" : m.kind === "reflex" || isRejection(m) ? "warning" : undefined);

/** The glyph of a mark, one per meaning (ADR-0042 §4): a failure is ✕, a reflex ▲; the others by kind, in the kind's hue. */
export function glyphOf(m: Mark): string {
  if (isFailure(m)) return "✕";
  if (m.kind === "reflex" || isRejection(m)) return "▲";
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

/** The width (px) of a bin of the Timeline: a count label (`▪×19`) fits in one. */
export const BIN_PX = 32;

/** A flag (a failure, a reflex, a refused start) at its place on its lane: it is drawn on its own, never folded into a count. */
export interface FlagMark {
  readonly lane: number;
  /** Position along the track (px). */
  readonly px: number;
  readonly mark: Mark;
}

/** The marks of a lane that fall in one bin of `BIN_PX`: one glyph if they are one, a count if they are more, a density bar where the count has no room beside a flag. */
export interface MarkBin {
  readonly lane: number;
  /** The left edge of the bin along the track (px). */
  readonly x0: number;
  /** Where its glyph goes: the first mark's position (px). */
  readonly px: number;
  readonly count: number;
  /** The mark whose glyph stands for the bin: the first, or for a bin of several the one of the majority kind. */
  readonly shown: Mark;
  /** How many of each kind, most first. */
  readonly kinds: readonly { readonly kind: string; readonly count: number }[];
  /** One mark: its glyph. More: `count` (a label) or `bar` (a density bar, the counts in the tooltip, because a flag takes the place of the label). */
  readonly mode: "glyph" | "count" | "bar";
}

export interface BinnedMarks {
  readonly flags: readonly FlagMark[];
  readonly bins: readonly MarkBin[];
  /** The largest count of a bin: the height of a full density bar. */
  readonly maxCount: number;
}

/**
 * What the lanes draw. Flags are never counted: each is drawn where it is. The other marks of a lane are put in fixed bins of `BIN_PX` along the track, so two counts never
 * touch; a bin that has a flag in it or next to it shows a density bar instead of a count (a flag's glyph and a count would run into each other).
 */
export function binMarks(marks: readonly Mark[], lanes: readonly string[], scaleS: number, trackPx: number, binPx = BIN_PX): BinnedMarks {
  const flags: FlagMark[] = [];
  const groups = new Map<string, { lane: number; bin: number; items: Mark[]; px: number }>();
  const sorted = [...marks].sort((a, b) => a.t - b.t || a.seq - b.seq);
  for (const m of sorted) {
    const lane = laneIndex(lanes, m);
    const px = scaleS > 0 ? (m.t / scaleS) * trackPx : 0;
    if (flagRole(m) !== undefined) {
      flags.push({ lane, px, mark: m });
      continue;
    }
    const bin = Math.floor(px / binPx);
    const key = `${lane}:${bin}`;
    const g = groups.get(key);
    if (g) g.items.push(m);
    else groups.set(key, { lane, bin, items: [m], px });
  }
  const bins: MarkBin[] = [];
  let maxCount = 1;
  for (const g of groups.values()) {
    const byKind = new Map<string, number>();
    for (const m of g.items) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    const kinds = [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
    const majority = kinds[0]?.kind;
    const x0 = g.bin * binPx;
    const crowded = g.items.length > 1 && flags.some((f) => f.lane === g.lane && f.px >= x0 - 8 && f.px <= x0 + binPx + 8);
    maxCount = Math.max(maxCount, g.items.length);
    bins.push({
      lane: g.lane,
      x0,
      px: g.px,
      count: g.items.length,
      shown: g.items.find((m) => m.kind === majority) ?? (g.items[0] as Mark),
      kinds,
      mode: g.items.length === 1 ? "glyph" : crowded ? "bar" : "count",
    });
  }
  return { flags, bins, maxCount };
}

/** What a hover over a lane tells: the marks of the bin or the flag under `px` on that lane, in words. Empty when there is nothing there. */
export function describeAt(binned: BinnedMarks, lane: number, px: number, binPx = BIN_PX): string {
  const flag = binned.flags.find((f) => f.lane === lane && Math.abs(f.px - px) <= 6);
  if (flag) return `${flag.mark.kind}${flag.mark.op ? ` ${flag.mark.op}` : ""}${flag.mark.code ? ` · ${flag.mark.code}` : ""} · ${flag.mark.t.toFixed(1)} s`;
  const bin = binned.bins.find((b) => b.lane === lane && px >= b.x0 && px < b.x0 + binPx);
  if (!bin) return "";
  return `${bin.count} ${bin.count === 1 ? "mark" : "marks"}: ${bin.kinds.map((k) => `${k.kind} ×${k.count}`).join(", ")}`;
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
