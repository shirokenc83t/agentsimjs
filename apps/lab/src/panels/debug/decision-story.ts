import type { StoragePorts } from "@agentsim/storage";
import type { TraceRecord } from "@agentsim/trace";
import { recordBySeq, seqOfId } from "./trace-tree.ts";

// The story of one decision of a System 2 mind (F4 M4, T-123, the designer's LLMInspector): the request, every model call of the loop in order with the compute calls between them, the final answer, the retries
// and the fallback, the limit records, the decision and the action it started. Read through the storage ports from the records' own links (a model call is a child of the request, a compute call a child of
// the call that asked for it, the decision is caused by the request, the action by the decision), so it works for a run that is being recorded and for a recording alike. Pure apart from the reads.

export type Ports = Pick<StoragePorts, "trace">;

const payload = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
export const opOf = (r: TraceRecord): string => (typeof payload(r)["op"] === "string" ? (payload(r)["op"] as string) : "");

/** A model call of the decision with the compute calls it asked for, which come after it in the lane. */
export interface CallStory {
  readonly record: TraceRecord;
  readonly tools: readonly TraceRecord[];
}

export type StepKind = "request" | "call" | "tool" | "answer" | "invalid" | "fallback" | "limit" | "cache" | "action";
export interface Step {
  readonly kind: StepKind;
  readonly record: TraceRecord;
  /** The model call a compute call belongs to (its position among the calls, 0-based), for the tool steps. */
  readonly call?: number;
}

export interface DecisionStory {
  readonly agentId: string;
  readonly request: TraceRecord;
  readonly calls: readonly CallStory[];
  readonly decision: TraceRecord | undefined;
  /** The `start` of the action the decision began, when it began one. */
  readonly action: TraceRecord | undefined;
  readonly fallback: TraceRecord | undefined;
  /** Limit warnings and hits that came with the decision's calls, and misses of the cache. */
  readonly limits: readonly TraceRecord[];
  readonly other: readonly TraceRecord[];
  /** The lane, in the order things happened. */
  readonly steps: readonly Step[];
  /** The `thought` records of the agent's decisions, in order: where this one stands among them and its neighbours. */
  readonly decisions: readonly number[];
}

/** The request record a record belongs to: a request is its own, a decision is caused by one, a model call, a fallback or a limit record is its child, a compute call is the child of a call. */
export async function requestOf(ports: Ports, runId: string, r: TraceRecord): Promise<TraceRecord | undefined> {
  const op = opOf(r);
  if (op === "request") return r;
  if (op === "decision") {
    for (const c of r.causeIds ?? []) {
      const s = seqOfId(c);
      const cand = s === undefined ? undefined : await recordBySeq(ports, runId, s);
      if (cand !== undefined && opOf(cand) === "request") return cand;
    }
    return undefined;
  }
  // A compute call is the child of a model call, which is the child of the request; the other records of the mind are children of the request.
  let at: TraceRecord | undefined = r;
  for (let hops = 0; hops < 3 && at !== undefined; hops++) {
    const p: number | undefined = seqOfId(at.parentId);
    at = p === undefined ? undefined : await recordBySeq(ports, runId, p);
    if (at !== undefined && opOf(at) === "request") return at;
  }
  return undefined;
}

/** The story the record belongs to, or undefined when it is not part of a decision of a mind. */
export async function buildDecisionStory(ports: Ports, runId: string, seq: number): Promise<DecisionStory | undefined> {
  const root = await recordBySeq(ports, runId, seq);
  if (root === undefined) return undefined;
  const request = await requestOf(ports, runId, root);
  if (request === undefined || request.agentId === undefined) return undefined;
  const agentId = request.agentId;
  const children = await ports.trace.query({ runId, filter: `parent:#${request.seq}`, limit: 400 });
  const callRecords = children.filter((r) => opOf(r) === "llm-call").sort((a, b) => a.seq - b.seq);
  const calls: CallStory[] = [];
  for (const c of callRecords) {
    const tools = (await ports.trace.query({ runId, filter: `parent:#${c.seq}`, limit: 100 })).filter((r) => r.kind === "compute" && opOf(r) === "tool").sort((a, b) => a.seq - b.seq);
    calls.push({ record: c, tools });
  }
  const effects = await ports.trace.query({ runId, filter: `cause:#${request.seq}`, limit: 50 });
  const decision = effects.find((r) => opOf(r) === "decision");
  const action = decision === undefined ? undefined : (await ports.trace.query({ runId, filter: `cause:#${decision.seq}`, limit: 50 })).find((r) => r.kind === "action" && opOf(r) === "start");
  const fallback = children.find((r) => opOf(r) === "fallback");
  const limits = children.filter((r) => ["limit-warning", "limit-hit"].includes(opOf(r))).sort((a, b) => a.seq - b.seq);
  const other = children.filter((r) => ["cache-miss", "not-reproducible"].includes(opOf(r))).sort((a, b) => a.seq - b.seq);

  const steps: Step[] = [{ kind: "request", record: request }];
  const timeline: Step[] = [];
  calls.forEach((c, i) => {
    timeline.push({ kind: "call", record: c.record });
    if (payload(c.record)["outcome"] === "invalid") timeline.push({ kind: "invalid", record: c.record });
    for (const t of c.tools) timeline.push({ kind: "tool", record: t, call: i });
  });
  for (const l of limits) timeline.push({ kind: "limit", record: l });
  for (const o of other) timeline.push({ kind: "cache", record: o });
  if (fallback !== undefined) timeline.push({ kind: "fallback", record: fallback });
  // Calls, their tools and the invalid marks keep their own order (a mark follows its call); the rest is placed by when it was written.
  const ordered = [...timeline].sort((a, b) => a.record.seq - b.record.seq || (a.kind === "call" ? -1 : b.kind === "call" ? 1 : 0));
  steps.push(...ordered);
  if (decision !== undefined) steps.push({ kind: "answer", record: decision });
  if (action !== undefined) steps.push({ kind: "action", record: action });

  // The agent's decisions in order, to say which one this is and what its neighbours are.
  const thoughts = await ports.trace.query({ runId, filter: `agent:${agentId} kind:thought text:decision`, limit: 5000 });
  const decisions = thoughts.filter((r) => opOf(r) === "decision").map((r) => r.seq).sort((a, b) => a - b);
  return { agentId, request, calls, decision, action, fallback, limits, other, steps, decisions };
}

// ---- reading a model call ---------------------------------------------------------------------------------------------------------------------------

export interface PromptSection {
  readonly title: string;
  readonly text: string;
  /** Characters / 4, rounded up: the inspector says it is an estimate. */
  readonly tokens: number;
}

/** The sections of a prompt (the user message of a model call, `## Title` blocks) with their size in tokens (characters / 4, labelled by the UI). */
export function promptSections(messages: unknown): PromptSection[] {
  if (!Array.isArray(messages)) return [];
  const out: PromptSection[] = [];
  const system = (messages as { role?: unknown; content?: unknown }[]).find((m) => m.role === "system" && typeof m.content === "string");
  if (system !== undefined) out.push({ title: "system", text: system.content as string, tokens: Math.ceil((system.content as string).length / 4) });
  for (const m of messages as { role?: unknown; content?: unknown; toolCalls?: unknown; name?: unknown }[]) {
    if (typeof m.content !== "string" || m.role === "system") continue;
    if (m.role === "user" && m.content.includes("## ")) {
      for (const part of m.content.split(/\n\n(?=## )/)) {
        const head = /^## ([^\n]*)\n?([\s\S]*)$/.exec(part);
        if (head !== null) out.push({ title: head[1] as string, text: head[2] as string, tokens: Math.ceil(part.length / 4) });
        else out.push({ title: "user", text: part, tokens: Math.ceil(part.length / 4) });
      }
    } else {
      const title = m.role === "tool" ? `tool result · ${typeof m.name === "string" ? m.name : ""}`.trim() : m.role === "assistant" ? (m.toolCalls !== undefined ? "assistant · tool calls" : "assistant") : String(m.role);
      const text = m.toolCalls !== undefined ? `${m.content}${m.content === "" ? "" : "\n"}${JSON.stringify(m.toolCalls)}` : m.content;
      out.push({ title, text, tokens: Math.ceil(text.length / 4) });
    }
  }
  return out;
}

/** The notebook the mind had at the request, as its self view carried it. */
export function notebookAt(request: TraceRecord): string {
  const self = payload(request)["self"] as { notebook?: unknown } | undefined;
  return typeof self?.notebook === "string" ? self.notebook : "";
}

/** The short words of one model call for its row: `2 702 → 61 tok`. */
export function callTokens(call: TraceRecord): { readonly input: number; readonly output: number } | undefined {
  const u = payload(call)["usage"] as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  return typeof u?.inputTokens === "number" && typeof u.outputTokens === "number" ? { input: u.inputTokens, output: u.outputTokens } : undefined;
}

/** What a model call said, for its row: the text of its answer (a tool call's name when it asked for one). */
export function callSays(call: TraceRecord): string {
  const resp = payload(call)["response"] as { content?: unknown; toolCalls?: { name?: unknown }[]; error?: unknown } | undefined;
  if (resp === undefined) return "";
  if (Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0) return `asks for ${resp.toolCalls.map((t) => String(t.name)).join(", ")}`;
  if (typeof resp.content === "string") {
    try {
      const j = JSON.parse(resp.content) as { rationale?: unknown; action?: unknown };
      if (typeof j.rationale === "string") return j.rationale;
      if (typeof j.action === "string") return `answer: ${j.action}`;
    } catch {
      // not JSON: show the text as it is
    }
    return resp.content.slice(0, 200);
  }
  return typeof resp.error === "string" ? resp.error : "";
}
