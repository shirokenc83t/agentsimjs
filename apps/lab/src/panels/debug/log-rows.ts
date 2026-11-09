import { GLYPH } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";

/** How an action ended, for the result column: a glyph and the word (a failure is also what tints the row). */
export const resultOf = (r: TraceRecord): { text: string; failed: boolean } | undefined => {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown; status?: unknown; failure?: { code?: unknown } }) : {};
  if (r.kind !== "action" || p.op !== "end" || typeof p.status !== "string") return undefined;
  if (p.status === "failed") return { text: `${GLYPH.fail} failed${typeof p.failure?.code === "string" ? ` · ${p.failure.code}` : ""}`, failed: true };
  return { text: p.status === "succeeded" ? `${GLYPH.ok} succeeded` : `${GLYPH.idle} ${p.status}`, failed: false };
};

/** The tag and the hue family of a row: the kind's own (`KIND_STYLE`), except the task records of a mind's list (events of op `task` and `task_step`), which are `TSK` in the run family (F4b M2, U-024). */
export function tagOf(r: TraceRecord, style: { readonly family: string; readonly tag: string } | undefined): { readonly tag: string; readonly family: string } {
  const op = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown }).op : undefined;
  if (r.kind === "event" && (op === "task" || op === "task_step")) return { tag: "TSK", family: "cyan" };
  return { tag: style?.tag ?? r.kind.slice(0, 3).toUpperCase(), family: style?.family ?? "slate" };
}

const spaced = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The summary line of the records of a System 2 mind (F4 M4, T-123): a model call, a compute call, a limit record, a fallback, a miss of the cache. Undefined for any other record. */
function mindSummary(r: TraceRecord, op: string, p: Record<string, unknown>): string | undefined {
  if (op === "llm-call") {
    const u = p["usage"] as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    const tokens = num(u?.inputTokens) !== undefined && num(u?.outputTokens) !== undefined ? `${spaced(u?.inputTokens as number)} → ${spaced(u?.outputTokens as number)} tok` : "";
    const resp = p["response"] as { toolCalls?: unknown[] } | undefined;
    const asks = Array.isArray(resp?.toolCalls) && resp.toolCalls.length > 0 ? `asks ${resp.toolCalls.length} tool${resp.toolCalls.length === 1 ? "" : "s"}` : "";
    const lat = num(p["latencyMs"]) === undefined ? "" : `${((p["latencyMs"] as number) / 1000).toFixed(1)} s`;
    return ["llm-call", `attempt ${String(p["attempt"] ?? 1)}`, tokens, lat, typeof p["outcome"] === "string" && p["outcome"] !== "ok" ? (p["outcome"] as string) : "", asks, p["cacheHit"] === true ? "cache" : ""].filter((x) => x !== "").join(" · ");
  }
  if (r.kind === "compute" && op === "tool") {
    const result = p["ok"] === false ? `${String(p["code"] ?? "refused")}` : String(p["status"] ?? "");
    const exp = num(p["expansions"]);
    return ["tool", String(p["tool"] ?? ""), result, exp === undefined || exp === 0 ? "" : `${spaced(exp)} exp`].filter((x) => x !== "").join(" · ");
  }
  if (op === "limit-warning") return `limit-warning · ${String(p["limit"])} ${String(p["pct"])} % (${spaced(Number(p["used"]))} of ${spaced(Number(p["max"]))})`;
  if (op === "limit-hit") return `limit-hit · ${String(p["limit"])} ${spaced(Number(p["used"]))} of ${spaced(Number(p["max"]))}`;
  if (op === "raiseLimit") return `raiseLimit · ${String(p["limit"])} ${spaced(Number(p["before"]))} → ${spaced(Number(p["after"]))}`;
  if (op === "fallback") return `fallback · ${String(p["decision"] ?? "")} · ${String(p["reason"] ?? "").slice(0, 80)}`;
  if (op === "cache-miss") return `cache-miss · attempt ${String(p["attempt"] ?? 1)}`;
  if (op === "not-reproducible") return `not-reproducible · from tick ${String(p["fromTick"] ?? "")}`;
  // The task list of a mind (F4b M2): the list as written, and each step as the world marks it.
  if (op === "task") return `list written · ${Array.isArray(p["steps"]) ? p["steps"].length : "?"} steps`;
  if (op === "task_step") {
    const status = String(p["status"] ?? "");
    const glyph = status === "running" ? "▶" : status === "done" ? "✓" : p["outcome"] === "preempted" ? "▲" : "✕";
    const word = status === "failed" && typeof p["outcome"] === "string" ? p["outcome"] : status;
    return `step ${String(p["step"])} of ${String(p["of"])} ${glyph} ${word}${typeof p["code"] === "string" && p["code"] !== word ? ` · ${p["code"]}` : ""}`;
  }
  return undefined;
}

export const summary = (r: TraceRecord): string => {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
  const op = typeof p["op"] === "string" ? p["op"] : "";
  const name = typeof p["name"] === "string" ? p["name"] : "";
  const mind = mindSummary(r, op, p);
  if (mind !== undefined) return mind;
  // A mission's decision says where in the mission it is: `decision · step 2 of 4 · goTo`, `… · done`, `… · stopped`.
  const held = op === "decision" && typeof p["held"] === "number" && p["held"] > 0 ? `held ${p["held"]}` : "";
  if (op === "decision" && p["continued"] === true) {
    // A decision that went on with the running action (U-024): `#3 · ↻ continued goTo act-000002 · timer`: the trigger is the event kinds of the request it answered.
    const ev = Array.isArray(p["events"]) ? [...new Set((p["events"] as { kind?: unknown }[]).map((e) => String(e.kind)))].join(", ") : "";
    return ["decision", `↻ continued ${String(p["actionId"] ?? "")}`, ev, held].filter((x) => x !== "").join(" · ");
  }
  if (op === "decision" && typeof p["step"] === "number" && typeof p["of"] === "number") {
    const d = p["decision"] as { kind?: unknown; name?: unknown } | undefined;
    const what = p["stop"] !== undefined ? "stopped" : p["done"] === true ? "done" : typeof d?.name === "string" ? d.name : "";
    return ["decision", `step ${p["step"]} of ${p["of"]}`, what, held].filter((x) => x !== "").join(" · ");
  }
  return [op, name, r.detail ?? "", held].filter((x) => x !== "").join(" · ");
};
