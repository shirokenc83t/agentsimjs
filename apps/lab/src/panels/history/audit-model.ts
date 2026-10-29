import type { TraceRecord } from "@agentsim/trace";
import { reflexWords } from "../agent-views.ts";
import { seqOfId } from "../debug/trace-tree.ts";
import { rootNodes } from "./history-model.ts";

// The audit of one agent (T-103, U-017): one row per action in time order, with its outcome and duration, the reason in words and what caused it; reflexes, replans, recoveries and
// refusals inside an action are indented sub-rows, the mission's stop is a row of its own, and idle stretches are rows too. Pure: records in, rows out.

export type AuditKind = "action" | "reflex" | "replan" | "recovery" | "refusal" | "stop" | "idle";

export interface AuditRow {
  readonly key: string;
  readonly level: 0 | 1;
  readonly kind: AuditKind;
  readonly t0: number;
  readonly t1: number;
  readonly seq: number | undefined;
  readonly glyph: string;
  /** The action with its arguments (`goTo (50, 20)`), or what the row is (`reflex obstacle ahead`, `idle`). */
  readonly what: string;
  /** How it ended: `✓ 3.2 s`, `✕ 5.0 s`, `▶ running`; empty for a point. */
  readonly outcome: string;
  readonly reason: string;
  readonly causedBy: string;
  readonly status: string | undefined;
}

const payloadOf = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const words = (code: string): string => code.replace(/_/g, " ");

/** A record in words, with its number: `mission step 2 of 3 #317`, `command · explore #2410`, `reflex obstacle ahead #2211`, `explore #318`. */
export function recordWords(r: TraceRecord): string {
  const p = payloadOf(r);
  const op = str(p["op"]);
  const n = `#${r.seq}`;
  if (r.kind === "thought" && op === "decision" && typeof p["step"] === "number") return p["stop"] !== undefined ? `mission stop at step ${String(p["step"])} of ${String(p["of"])} ${n}` : p["done"] === true ? `mission done ${n}` : `mission step ${String(p["step"])} of ${String(p["of"])} ${n}`;
  if (r.kind === "injected" && op === "command") return `command · ${str(p["name"]) ?? "command"} ${n}`;
  if (r.kind === "reflex") return `reflex ${reflexWords(str(p["code"]) ?? str(p["reflex"]) ?? "reflex")} ${n}`;
  if (r.kind === "action") return `${op === "start" || op === undefined ? "" : `${op} `}${str(p["name"]) ?? "action"} ${n}`;
  if (r.kind === "compute") return `compute ${op ?? ""} ${n}`.replace("  ", " ");
  return `${r.kind}${op === undefined ? "" : ` ${op}`} ${n}`;
}

/** The injected commands by their input id (`inp-000002`): the start of an action a command made carries the same input id, which is how the two are associated (not a cause link). */
export function commandsByInput(records: readonly TraceRecord[]): Map<string, TraceRecord> {
  const out = new Map<string, TraceRecord>();
  for (const r of records) {
    const p = payloadOf(r);
    if (r.kind === "injected" && p["op"] === "command" && typeof p["inputId"] === "string") out.set(p["inputId"], r);
  }
  return out;
}

/** `command at 0.1 s (input inp-000002, #14)`: said as an association by input id, since the trace has no cause link there. */
export function commandWords(c: TraceRecord): string {
  return `command at ${c.simTime.toFixed(1)} s (input ${str(payloadOf(c)["inputId"]) ?? "?"}, #${c.seq})`;
}

/**
 * What caused a record, in words: the first record it names as a cause that is among `byId` (or its bare number when it was not read); when it names none, the command that has the
 * same input id as the record (an association, said so); else "none recorded".
 */
export function causeWords(r: TraceRecord, byId: ReadonlyMap<string, TraceRecord>, byInput?: ReadonlyMap<string, TraceRecord>): string {
  const id = r.causeIds?.[0];
  if (id === undefined) {
    const input = str(payloadOf(r)["inputId"]);
    const c = input === undefined ? undefined : byInput?.get(input);
    return c === undefined ? "none recorded" : commandWords(c);
  }
  const c = byId.get(id);
  if (c !== undefined) return recordWords(c);
  const seq = seqOfId(id);
  return seq === undefined ? id : `record #${seq}`;
}

const failureOf = (p: Record<string, unknown>): { code: string | undefined; message: string | undefined } => {
  const f = p["failure"];
  if (typeof f === "string") return { code: f, message: undefined };
  const o = f !== null && typeof f === "object" ? (f as { code?: unknown; message?: unknown }) : {};
  return { code: str(o.code), message: str(o.message) };
};

/** The rows of the audit: `records` are the agent's root records (starts, ends, refusals, commands, reflexes, decisions) and its replans and recoveries, in any order. */
export function auditRows(records: readonly TraceRecord[], endS: number): AuditRow[] {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const byId = new Map(sorted.map((r) => [r.id, r] as const));
  const byInput = commandsByInput(sorted);
  const ends = new Map<string, TraceRecord>();
  for (const r of sorted) {
    const p = payloadOf(r);
    if (r.kind === "action" && p["op"] === "end" && typeof p["actionId"] === "string") ends.set(p["actionId"], r);
  }
  const { actions } = rootNodes(sorted, endS);
  const starts = sorted.filter((r) => r.kind === "action" && payloadOf(r)["op"] === "start");
  const rows: AuditRow[] = [];
  const bars = actions.filter((n) => n.kind === "action");
  for (const bar of bars) {
    const start = bar.record as TraceRecord;
    const end = ends.get(str(payloadOf(start)["actionId"]) ?? "");
    const f = end === undefined ? { code: undefined, message: undefined } : failureOf(payloadOf(end));
    const dur = (bar.t1 - bar.t0).toFixed(1);
    const status = bar.status ?? "running";
    const next = starts.find((s) => s.seq > start.seq);
    const endCause = end?.causeIds?.[0] === undefined ? undefined : byId.get(end.causeIds[0]);
    let reason: string;
    if (status === "running") reason = "still running when the record ends";
    else if (status === "succeeded") reason = "completed";
    else if (status === "preempted") reason = endCause !== undefined ? `preempted by ${recordWords(endCause)}` : (f.message ?? (next !== undefined ? `replaced by ${str(payloadOf(next)["name"]) ?? "another action"}` : "preempted"));
    else reason = f.message ?? (f.code === undefined ? "failed" : words(f.code));
    rows.push({ key: `a${start.seq}`, level: 0, kind: "action", t0: bar.t0, t1: bar.t1, seq: start.seq, glyph: bar.glyph, what: bar.label, outcome: status === "running" ? "▶ running" : `${bar.glyph} ${dur} s`, reason, causedBy: causeWords(start, byId, byInput), status });
    // A sub-row says what recorded cause it has, else which action it is within.
    const within = (r: TraceRecord) => (r.causeIds?.[0] === undefined ? `within ${bar.label.split(" ")[0] ?? "the action"} (#${start.seq})` : causeWords(r, byId, byInput));
    // Inside the action: the reflexes that hit it, its replans and recoveries, the commands refused while it ran.
    for (const r of sorted) {
      if (r.seq === start.seq) continue;
      const p = payloadOf(r);
      const op = str(p["op"]);
      const inside = r.simTime >= bar.t0 - 1e-9 && r.simTime <= bar.t1 + 1e-9;
      if (r.kind === "reflex" && inside) rows.push({ key: `x${r.seq}`, level: 1, kind: "reflex", t0: r.simTime, t1: r.simTime, seq: r.seq, glyph: "▲", what: `reflex ${str(p["reflex"]) ?? ""}`.trim(), outcome: "", reason: reflexWords(str(p["code"]) ?? str(p["reflex"]) ?? "reflex"), causedBy: within(r), status: undefined });
      else if (r.kind === "action" && r.parentId === start.id && (op === "replan" || op === "recovery")) {
        const why = str(p["reason"]) ?? "";
        rows.push({ key: `${op === "replan" ? "p" : "v"}${r.seq}`, level: 1, kind: op === "replan" ? "replan" : "recovery", t0: r.simTime, t1: r.simTime, seq: r.seq, glyph: "↻", what: op === "replan" ? "replan" : `recovery${str(p["kind"]) === undefined ? "" : ` · ${str(p["kind"])}`}`, outcome: "", reason: words(why), causedBy: within(r), status: undefined });
      } else if (r.kind === "action" && op === "rejected" && inside) {
        const code = failureOf(p).code ?? "refused";
        rows.push({ key: `r${r.seq}`, level: 1, kind: "refusal", t0: r.simTime, t1: r.simTime, seq: r.seq, glyph: "✕", what: `${str(p["name"]) ?? "action"} refused`, outcome: "", reason: words(code), causedBy: within(r), status: "refused" });
      }
    }
  }
  // Refusals and reflexes outside any action are rows of their own (level 0); the mission's stop; the idle stretches.
  const inAny = (t: number) => bars.some((b) => t >= b.t0 - 1e-9 && t <= b.t1 + 1e-9);
  for (const r of sorted) {
    const p = payloadOf(r);
    if (r.kind === "reflex" && !inAny(r.simTime)) rows.push({ key: `x${r.seq}`, level: 0, kind: "reflex", t0: r.simTime, t1: r.simTime, seq: r.seq, glyph: "▲", what: `reflex ${str(p["reflex"]) ?? ""}`.trim(), outcome: "", reason: reflexWords(str(p["code"]) ?? str(p["reflex"]) ?? "reflex"), causedBy: causeWords(r, byId, byInput), status: undefined });
    else if (r.kind === "action" && p["op"] === "rejected" && !inAny(r.simTime)) rows.push({ key: `r${r.seq}`, level: 0, kind: "refusal", t0: r.simTime, t1: r.simTime, seq: r.seq, glyph: "✕", what: `${str(p["name"]) ?? "action"} refused`, outcome: "", reason: words(failureOf(p).code ?? "refused"), causedBy: causeWords(r, byId, byInput), status: "refused" });
    else if (r.kind === "thought" && p["op"] === "decision" && p["stop"] !== undefined) {
      const stop = p["stop"];
      const why = typeof stop === "string" ? stop : str((stop as { reason?: unknown } | null)?.reason) ?? "";
      rows.push({ key: `m${r.seq}`, level: 0, kind: "stop", t0: r.simTime, t1: r.simTime, seq: r.seq, glyph: "■", what: `mission stopped at step ${String(p["step"])} of ${String(p["of"])}`, outcome: "", reason: why === "" ? "the mission stopped" : words(why), causedBy: causeWords(r, byId, byInput), status: undefined });
    }
  }
  for (const n of actions.filter((x) => x.kind === "idle")) rows.push({ key: n.key, level: 0, kind: "idle", t0: n.t0, t1: n.t1, seq: undefined, glyph: "○", what: "idle", outcome: `${(n.t1 - n.t0).toFixed(1)} s`, reason: "no action running", causedBy: "—", status: undefined });
  // Time order; a sub-row follows the action it is inside (it has the same or a later time, and a larger seq than its action).
  return rows.sort((a, b) => a.t0 - b.t0 || (a.level === b.level ? (a.seq ?? -1) - (b.seq ?? -1) : a.level - b.level));
}

/** The rows that fall in a window (a row is in when it overlaps it): the brush of the history filters the audit. */
export function rowsInWindow(rows: readonly AuditRow[], win: { readonly t0: number; readonly t1: number } | undefined): AuditRow[] {
  return win === undefined ? [...rows] : rows.filter((r) => r.t1 >= win.t0 && r.t0 <= win.t1);
}

/** The audit as CSV (the shape of the table). */
export function auditCsv(rows: readonly AuditRow[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ["t0_s,t1_s,level,kind,what,outcome,reason,caused_by,seq", ...rows.map((r) => [r.t0.toFixed(1), r.t1.toFixed(1), r.level, r.kind, q(r.what), q(r.outcome), q(r.reason), q(r.causedBy), r.seq ?? ""].join(","))].join("\n");
}

/**
 * The findings line for the agent, in words: what it ran, how it went, the reflexes and the commands. Left out is what the records do not hold; nothing is guessed.
 */
export function auditFindings(agentId: string, rows: readonly AuditRow[], records: readonly TraceRecord[]): string {
  const actions = rows.filter((r) => r.kind === "action");
  if (actions.length === 0) return `${agentId} has no recorded actions.`;
  const total = actions.reduce((s, r) => s + (r.t1 - r.t0), 0);
  const parts = actions.map((r) => {
    const name = r.what.split(" ")[0] ?? r.what;
    return r.status === "succeeded" ? `${name} ✓` : r.status === "running" ? `${name} ▶ still running` : `${name} ${r.glyph} ${r.status ?? ""} at ${r.t1.toFixed(1)} s${r.reason === "" ? "" : ` (${r.reason})`}`;
  });
  const reflexes = rows.filter((r) => r.kind === "reflex");
  const commands = records.filter((r) => r.kind === "injected" && payloadOf(r)["op"] === "command");
  const stop = rows.find((r) => r.kind === "stop");
  const out = [`${agentId} ran ${actions.length} action${actions.length === 1 ? "" : "s"} in ${total.toFixed(1)} s: ${parts.slice(0, 6).join(", ")}${parts.length > 6 ? ", …" : ""}`];
  if (stop !== undefined) out.push(`${stop.what.replace("mission stopped", "the mission stopped")} at ${stop.t0.toFixed(1)} s`);
  out.push(reflexes.length === 0 ? "no reflex" : reflexes.length === 1 ? `one reflex at ${(reflexes[0] as AuditRow).t0.toFixed(1)} s` : `${reflexes.length} reflexes, the first at ${(reflexes[0] as AuditRow).t0.toFixed(1)} s`);
  if (commands.length > 0) out.push(commands.length === 1 ? `one command at ${(commands[0] as TraceRecord).simTime.toFixed(1)} s` : `${commands.length} commands`);
  return `${out.join("; ")}.`;
}
