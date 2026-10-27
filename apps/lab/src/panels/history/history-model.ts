import type { TraceRecord } from "@agentsim/trace";

// The model of the agent action history (T-102, ADR-0043, the designer's AgentHistory): one agent over the whole run on one time axis, one row per level; a node opens into the records it
// came from or caused (by their parent and cause links) on the row below. Pure and deterministic: positions come from time and `seq` only, nothing is random or measured, so the same
// records and the same width give the same picture.

export type HistoryKind = "command" | "decision" | "action" | "reflex" | "failure" | "idle" | "record" | "group";
export type HistoryStatus = "running" | "succeeded" | "failed" | "preempted" | "refused";

export interface HistoryNode {
  /** Stable across looks: the record's seq, or what the node is made of for an idle span or a group. */
  readonly key: string;
  readonly seq: number | undefined;
  readonly record: TraceRecord | undefined;
  readonly kind: HistoryKind;
  readonly label: string;
  /** The outcome glyph or the kind's: ▶ running, ✓ done, ✕ failed, ▲ preempted or a reflex, ◆ a command, ◇ a mission decision, ▪ a record. */
  readonly glyph: string;
  readonly t0: number;
  /** The end of a bar; equal to `t0` for a point. */
  readonly t1: number;
  readonly status?: HistoryStatus | undefined;
  readonly op?: string | undefined;
  /** A node that can open into its children (an action, a command or decision, a record that has some). */
  readonly canExplode: boolean;
  /** A group of narrow nodes folded into one ("… 37 iterations ▸"): what it stands for. */
  readonly members?: readonly HistoryNode[] | undefined;
}

const payloadOf = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** An argument list in words for a label: `(50, 20)`, `r 15 m`, `20 m`. */
function argsLabel(name: string, params: unknown): string {
  const a = (params ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
  if (name === "goTo" && n("xM") !== undefined && n("yM") !== undefined) return ` (${n("xM")}, ${n("yM")})`;
  if (name === "explore" && n("radiusM") !== undefined) return ` r ${n("radiusM")} m`;
  if (name === "takeoff" && n("altitudeM") !== undefined) return ` ${n("altitudeM")} m`;
  if (name === "hold" && n("durationS") !== undefined) return ` ${n("durationS")} s`;
  return "";
}

const STATUS_GLYPH: Record<HistoryStatus, string> = { running: "▶", succeeded: "✓", failed: "✕", preempted: "▲", refused: "✕" };

/**
 * The first two rows of the history of one agent from its records: the commands and mission decisions (◆ ◇), and the actions as bars from start to end with their outcome (a running action
 * runs to `endS`), with the reflexes and failures that hit them and the idle time between them. `records` are the agent's action, injected, reflex and decision records, in any order.
 */
export function rootNodes(records: readonly TraceRecord[], endS: number): { commands: HistoryNode[]; actions: HistoryNode[] } {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const ends = new Map<string, TraceRecord>();
  for (const r of sorted) {
    const p = payloadOf(r);
    if (r.kind === "action" && p["op"] === "end" && typeof p["actionId"] === "string") ends.set(p["actionId"], r);
  }
  const commands: HistoryNode[] = [];
  const actions: HistoryNode[] = [];
  for (const r of sorted) {
    const p = payloadOf(r);
    const op = str(p["op"]);
    if (r.kind === "action" && op === "start") {
      const end = ends.get(str(p["actionId"]) ?? "");
      const status = (end === undefined ? "running" : (str(payloadOf(end)["status"]) as HistoryStatus | undefined)) ?? "succeeded";
      const name = str(p["name"]) ?? "action";
      actions.push({ key: `s${r.seq}`, seq: r.seq, record: r, kind: "action", label: `${name}${argsLabel(name, p["params"])}`, glyph: STATUS_GLYPH[status], t0: r.simTime, t1: end?.simTime ?? endS, status, op, canExplode: true });
      if (status === "failed" && end !== undefined) {
        const code = str((payloadOf(end)["failure"] as { code?: unknown } | undefined)?.code) ?? "failed";
        actions.push({ key: `f${end.seq}`, seq: end.seq, record: end, kind: "failure", label: `${name} failed · ${code}`, glyph: "✕", t0: end.simTime, t1: end.simTime, status: "failed", op: "end", canExplode: true });
      }
    } else if (r.kind === "action" && op === "rejected") {
      const f = payloadOf(r)["failure"] as { code?: unknown } | string | undefined;
      const code = typeof f === "string" ? f : (str(f?.code) ?? "refused");
      actions.push({ key: `r${r.seq}`, seq: r.seq, record: r, kind: "failure", label: `${str(p["name"]) ?? "action"} refused · ${code}`, glyph: "✕", t0: r.simTime, t1: r.simTime, status: "refused", op, canExplode: true });
    } else if (r.kind === "reflex") {
      actions.push({ key: `x${r.seq}`, seq: r.seq, record: r, kind: "reflex", label: `${str(p["reflex"]) ?? "reflex"} · ${str(p["code"]) ?? ""}`.trim(), glyph: "▲", t0: r.simTime, t1: r.simTime, op: "reflex", canExplode: true });
    } else if (r.kind === "injected" && op === "command") {
      const ok = p["ok"] !== false;
      commands.push({ key: `c${r.seq}`, seq: r.seq, record: r, kind: "command", label: `${str(p["name"]) ?? "command"}${ok ? "" : " refused"}`, glyph: "◆", t0: r.simTime, t1: r.simTime, op, canExplode: true });
    } else if (r.kind === "thought" && op === "decision" && typeof p["step"] === "number") {
      const d = p["decision"] as { name?: unknown } | undefined;
      const what = p["stop"] !== undefined ? "stopped" : p["done"] === true ? "done" : (str(d?.name) ?? "");
      commands.push({ key: `d${r.seq}`, seq: r.seq, record: r, kind: "decision", label: `decision · step ${String(p["step"])} of ${String(p["of"])}${what === "" ? "" : ` · ${what}`}`, glyph: "◇", t0: r.simTime, t1: r.simTime, op, canExplode: true });
    }
  }
  return { commands, actions: withIdle(actions, endS) };
}

/** The action row with the idle time between its bars (a span of at least half a second where no action runs) as hatched nodes of their own. */
function withIdle(row: readonly HistoryNode[], endS: number): HistoryNode[] {
  const bars = row.filter((n) => n.kind === "action");
  const out: HistoryNode[] = [...row];
  let cursor = 0;
  for (const b of bars) {
    if (b.t0 - cursor >= 0.5) out.push(idleNode(cursor, b.t0));
    cursor = Math.max(cursor, b.t1);
  }
  if (endS - cursor >= 0.5 && bars.length > 0) out.push(idleNode(cursor, endS));
  return out.sort((a, b) => a.t0 - b.t0 || (a.seq ?? -1) - (b.seq ?? -1));
}

const idleNode = (t0: number, t1: number): HistoryNode => ({ key: `i${t0.toFixed(3)}`, seq: undefined, record: undefined, kind: "idle", label: "idle", glyph: "○", t0, t1, canExplode: false });

/**
 * The children of a node, from the records its `parent` and `cause` links reach (the caller reads them from storage, any order). A phase lasts until the next phase; an explore
 * iteration is the bar from its `start` event to its `end` event (its end record is part of the bar, not a node of its own); the rest are points. An iteration is labelled with its
 * number and centre, and with the groups it visited when its end says so. "Area first seen" is not in the records, so it is not shown.
 */
export function childNodes(children: readonly TraceRecord[], endS: number, parentEndS?: number): HistoryNode[] {
  const sorted = [...children].sort((a, b) => a.seq - b.seq);
  const limit = parentEndS ?? endS;
  const numberOf = (p: Record<string, unknown>) => (typeof p["iteration"] === "number" ? p["iteration"] : undefined);
  const iterEnds = new Map<number, TraceRecord>();
  for (const r of sorted) {
    const p = payloadOf(r);
    const no = numberOf(p);
    if (str(p["op"]) === "explore-iteration" && p["event"] === "end" && no !== undefined) iterEnds.set(no, r);
  }
  const starts = new Set(sorted.filter((r) => str(payloadOf(r)["op"]) === "explore-iteration" && payloadOf(r)["event"] !== "end").map((r) => numberOf(payloadOf(r))));
  const nextOf = (from: number, op: string, test: (p: Record<string, unknown>) => boolean): TraceRecord | undefined => sorted.find((r) => r.seq > from && str(payloadOf(r)["op"]) === op && test(payloadOf(r)));
  const nodes: HistoryNode[] = [];
  for (const r of sorted) {
    const p = payloadOf(r);
    const op = str(p["op"]) ?? r.kind;
    const no = numberOf(p);
    // The end of an iteration whose start is here is drawn as the end of that bar.
    if (op === "explore-iteration" && p["event"] === "end" && starts.has(no)) continue;
    const isPhase = op === "phase";
    const isIteration = op === "explore-iteration";
    let t1 = r.simTime;
    if (isPhase) t1 = nextOf(r.seq, "phase", () => true)?.simTime ?? Math.max(r.simTime, limit);
    else if (isIteration) {
      const end = no === undefined ? undefined : iterEnds.get(no);
      t1 = end?.simTime ?? nextOf(r.seq, "explore-iteration", (q) => q["event"] !== "end")?.simTime ?? Math.max(r.simTime, limit);
    }
    const visited = isIteration && no !== undefined ? iterEnds.get(no)?.payload : undefined;
    const visitedN = visited !== null && typeof visited === "object" ? (visited as { visited?: unknown }).visited : undefined;
    const label = isPhase
      ? `phase · ${str(p["to"]) ?? ""}`.trim()
      : isIteration
        ? `${iterationLabel(p)}${typeof visitedN === "number" ? ` · ${visitedN} group${visitedN === 1 ? "" : "s"}` : ""}`
        : r.kind === "action" && op === "start"
          ? `${str(p["name"]) ?? "action"}${argsLabel(str(p["name"]) ?? "", p["params"])}`
          : op === "explore-target"
            ? `target · ${str(p["event"]) ?? ""}${pointText(p["goal"] ?? p["group"]) ?? ""}`.replace(/ · $/, "")
            : `${op}${str(p["name"]) ? ` · ${str(p["name"])}` : ""}${targetOf(p) ?? ""}`;
    const failed = op === "end" && str(p["status"]) === "failed";
    const status = op === "end" ? (str(p["status"]) as HistoryStatus | undefined) : undefined;
    nodes.push({
      key: `${isPhase || isIteration ? "b" : "p"}${r.seq}`,
      seq: r.seq,
      record: r,
      kind: r.kind === "reflex" ? "reflex" : failed ? "failure" : "record",
      label,
      glyph: r.kind === "reflex" ? "▲" : status !== undefined ? STATUS_GLYPH[status] : "▪",
      t0: r.simTime,
      t1: Math.max(t1, r.simTime),
      status,
      op,
      canExplode: true,
    });
  }
  return nodes;
}

/** A point written as `(x, y)` from `[x, y]` or `{ xM, yM }` (whole metres), or undefined. */
function pointText(v: unknown): string | undefined {
  if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") return ` (${v[0].toFixed(0)}, ${v[1].toFixed(0)})`;
  const t = v as { xM?: unknown; yM?: unknown; x?: unknown; y?: unknown } | null | undefined;
  const x = typeof t?.xM === "number" ? t.xM : typeof t?.x === "number" ? t.x : undefined;
  const y = typeof t?.yM === "number" ? t.yM : typeof t?.y === "number" ? t.y : undefined;
  return x !== undefined && y !== undefined ? ` (${x.toFixed(0)}, ${y.toFixed(0)})` : undefined;
}

const targetOf = (p: Record<string, unknown>): string | undefined => pointText(p["target"] ?? p["frontier"] ?? p["goal"]);

/** `iteration 6 (x, y)` with the centre (or the target) when the record says it: the duration is the bar's own length. */
function iterationLabel(p: Record<string, unknown>): string {
  const n = typeof p["iteration"] === "number" ? p["iteration"] : typeof p["n"] === "number" ? p["n"] : undefined;
  return `iteration${n === undefined ? "" : ` ${n}`}${pointText(p["centre"]) ?? targetOf(p) ?? ""}`;
}


// ---- layout ------------------------------------------------------------------------------------------------------------------------

export interface Placed {
  readonly node: HistoryNode;
  readonly x: number;
  readonly w: number;
  /** Sub-row inside the row: points and bars that would overlap are staggered by `seq` order. */
  readonly lane: number;
}

/** What a folded run is called in its label ("… 37 iterations ▸"). */
const GROUP_NAME: Readonly<Record<string, string>> = { "explore-iteration": "iterations", phase: "phases", "explore-target": "targets", replan: "replans", recovery: "recoveries", start: "actions", end: "ends" };

/** What a node of this width is drawn as: bars narrower than `minPx` of one op in a run fold into one group node. */
export function layoutRow(nodes: readonly HistoryNode[], axis: { readonly t0: number; readonly t1: number; readonly widthPx: number }, opts: { readonly minPx?: number; readonly foldAt?: number } = {}): { placed: Placed[]; lanes: number } {
  const minPx = opts.minPx ?? 6;
  const foldAt = opts.foldAt ?? 3;
  const span = Math.max(1e-9, axis.t1 - axis.t0);
  const px = (t: number) => ((t - axis.t0) / span) * axis.widthPx;
  const sorted = [...nodes].sort((a, b) => a.t0 - b.t0 || (a.seq ?? -1) - (b.seq ?? -1));
  // Fold the runs of narrow nodes of one op (each op on its own: phases and iterations interleave in time, and the phases fold whatever the iterations do): a run is nodes in
  // time order, each narrower than `minPx` and no more than two widths apart from the one before it.
  const foldable = (n: HistoryNode) => (n.kind === "action" || n.kind === "record") && px(n.t1) - px(n.t0) < minPx;
  const keep: HistoryNode[] = sorted.filter((n) => !foldable(n));
  const byOp = new Map<string, HistoryNode[]>();
  for (const n of sorted) if (foldable(n)) byOp.set(n.op ?? "record", [...(byOp.get(n.op ?? "record") ?? []), n]);
  const folded: HistoryNode[] = [...keep];
  for (const [op, list] of byOp) {
    let run: HistoryNode[] = [];
    const flush = () => {
      if (run.length >= foldAt) {
        const first = run[0] as HistoryNode;
        const last = run[run.length - 1] as HistoryNode;
        folded.push({ key: `g${op}-${first.seq ?? first.key}-${run.length}`, seq: undefined, record: undefined, kind: "group", label: `… ${run.length} ${GROUP_NAME[op] ?? `${op}s`} ▸`, glyph: "▪", t0: first.t0, t1: Math.max(last.t1, last.t0), op, canExplode: true, members: run });
      } else folded.push(...run);
      run = [];
    };
    for (const n of list) {
      const prev = run[run.length - 1];
      if (prev !== undefined && px(n.t0) - px(prev.t1) > minPx * 2) flush();
      run.push(n);
    }
    flush();
  }
  folded.sort((a, b) => a.t0 - b.t0 || (a.seq ?? -1) - (b.seq ?? -1) || a.key.localeCompare(b.key));
  // Stagger what overlaps, greedily in time and seq order (deterministic).
  const laneEnds: number[] = [];
  const placed: Placed[] = folded.map((node) => {
    const x = px(node.t0);
    const w = Math.max(node.kind === "idle" ? 0 : 0, px(node.t1) - x);
    const need = Math.max(w, minPx);
    let lane = laneEnds.findIndex((end) => end <= x);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = x + need + 1;
    return { node, x, w, lane };
  });
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

// ---- exploding ---------------------------------------------------------------------------------------------------------------------

/** The keys of the nodes opened, from the first row down: `path[i]` is the node of row `i + 1` that was opened to make row `i + 2`. */
export type OpenPath = readonly { readonly row: number; readonly key: string }[];

/** Opens `key` of `row`: the rows below `row` are replaced (one path, one branch at a time), the new row is added by the caller when its children are read. */
export function explode(path: OpenPath, row: number, key: string): OpenPath {
  return [...path.filter((p) => p.row < row), { row, key }];
}

/** Folds the last opened node (backspace). */
export const fold = (path: OpenPath): OpenPath => path.slice(0, -1);
/** Folds everything. */
export const collapseAll = (): OpenPath => [];

/** The breadcrumb of the opened path: `explore (15 m) › iteration 6 › ▲ reflex 39.1 s`, from the labels of the opened nodes. */
export function breadcrumb(labels: readonly string[]): string {
  return labels.join(" › ");
}

// ---- keyboard ----------------------------------------------------------------------------------------------------------------------

export interface RowView {
  readonly index: number;
  readonly placed: readonly Placed[];
}

/** Where an arrow key goes from the focused node: ← → the previous and next node of the row (by time, then seq), ↓ the first node of the row below, ↑ the node that was opened to make this row. */
export function navigate(rows: readonly RowView[], focus: { readonly row: number; readonly key: string } | undefined, dir: "left" | "right" | "up" | "down", path: OpenPath): { row: number; key: string } | undefined {
  const first = rows[0]?.placed[0];
  if (focus === undefined) return first === undefined ? undefined : { row: rows[0]?.index ?? 0, key: first.node.key };
  const rowView = rows.find((r) => r.index === focus.row);
  if (rowView === undefined) return focus;
  const order = [...rowView.placed].sort((a, b) => a.node.t0 - b.node.t0 || (a.node.seq ?? -1) - (b.node.seq ?? -1));
  const at = order.findIndex((p) => p.node.key === focus.key);
  if (dir === "left" || dir === "right") {
    const next = order[at + (dir === "left" ? -1 : 1)];
    return next === undefined ? focus : { row: focus.row, key: next.node.key };
  }
  if (dir === "down") {
    const below = rows.find((r) => r.index === focus.row + 1);
    const n = below?.placed[0];
    return n === undefined ? focus : { row: below?.index ?? focus.row + 1, key: n.node.key };
  }
  const opened = [...path].reverse().find((p) => p.row === focus.row - 1);
  return opened === undefined ? focus : { row: opened.row, key: opened.key };
}

// ---- axis ---------------------------------------------------------------------------------------------------------------------------

/** Round tick times for an axis from `t0` to `t1` (steps of 1, 2, 5 × 10^k seconds), at most about `max` of them. */
export function timeTicks(t0: number, t1: number, max: number): number[] {
  const span = t1 - t0;
  if (!(span > 0) || max < 1) return [];
  const raw = span / max;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}
