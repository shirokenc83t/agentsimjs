import type { TraceRecord } from "@agentsim/trace";
import { STEP_GLYPH, type StepState } from "../mission-view.ts";
import { opOf, type DecisionStory, type Ports } from "./decision-story.ts";

// The task list of a System 2 mind at one decision (F4b M2, the designer's TaskDecision board), read from the records, with no new record shape: the list as the world held it is `self.task` of the request;
// how each failed step failed (failed, preempted, refused) and its code are in the `task_step` records; where the list came from is the `task` records; what a decision held back, and whether it went on with the
// running action, are the `held` and `continued` of its record and the perception events of its request. The same step glyphs as the F3c mission view (`STEP_GLYPH`).

const payload = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});

/** The perception events: the ones a mind under the wake policy `task` is not woken by (the kinds of `isControl` in core, the others being control). */
export const PERCEPTION_KINDS: readonly string[] = ["detected", "lost", "frontierExhausted"];

interface ListStep {
  readonly text: string;
  readonly action?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly status: "pending" | "running" | "done" | "failed";
  readonly actionId?: string;
}

export interface TaskRow {
  /** 1-based, as the mind names it with `step`. */
  readonly n: number;
  readonly text: string;
  readonly action: string | undefined;
  readonly params: Readonly<Record<string, unknown>> | undefined;
  readonly actionId: string | undefined;
  readonly state: StepState;
  readonly glyph: string;
  /** The code a failed step ended with (`no_path`, `preempted`), from its `task_step` record. */
  readonly code: string | undefined;
  /** The step this decision's action works on (the `task_step` it caused). */
  readonly named: boolean;
}

export interface TaskStory {
  readonly rows: readonly TaskRow[];
  readonly counts: { readonly total: number; readonly done: number; readonly running: number; readonly failed: number };
  /** Where the list came from: written at decision `at` (a number among the agent's decisions, absent when unknown), or rewritten there over a list of `was` steps; `unchanged` says it has not changed since. */
  readonly source: { readonly kind: "written" | "rewritten"; readonly at: number | undefined; readonly was: number | undefined; readonly unchanged: boolean; readonly byThisDecision: boolean };
  /** `step 2 ✓ done · goTo act-000002 · at 31.2 s`, or undefined while nothing has ended. */
  readonly last: { readonly text: string } | undefined;
  /** The list stopped at a failed step: `list stopped at step 3 of 5`. */
  readonly stopped: string | undefined;
  /** The list this decision wrote when it is not the one the world held at its request: its steps, the one the decision bound to its action running, the others pending. */
  readonly fromThisDecision: boolean;
  /** When the decision rewrites a list the world held: the old list, kept apart (collapsed in the panel), with no step named in it. */
  readonly before?: { readonly rows: readonly TaskRow[] };
}

const asList = (v: unknown): { steps: readonly ListStep[]; running?: number; last?: { step: number; status: string; action: string; code?: string } } | undefined =>
  v !== null && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps) ? (v as never) : undefined;

/** The task list of a request record (`self.task`): undefined while the mind has none, or when the request was kept at `mind-io: metadata` (its body is a hash). */
export function taskOfRequest(request: TraceRecord): ReturnType<typeof asList> {
  const self = payload(request)["self"];
  return self !== null && typeof self === "object" ? asList((self as { task?: unknown }).task) : undefined;
}

const stateOf = (s: ListStep, outcome: string | undefined): StepState => (s.status === "failed" ? (outcome === "preempted" ? "preempted" : outcome === "refused" ? "refused" : "failed") : s.status);

/** The `perception events a request carried`, by kind (`detected 5 · lost 2`), for the REQ row and the summary of a decision that held some back. */
export function heldKinds(request: TraceRecord): { readonly total: number; readonly words: string } {
  const events = payload(request)["events"];
  if (!Array.isArray(events)) return { total: 0, words: "" };
  const by = new Map<string, number>();
  for (const e of events as { kind?: unknown; transitions?: unknown }[]) if (typeof e.kind === "string" && PERCEPTION_KINDS.includes(e.kind)) by.set(e.kind, (by.get(e.kind) ?? 0) + 1);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  return { total, words: [...by].map(([k, n]) => `${k} ${n}`).join(" · ") };
}

/** What a decision held back: the number its record carries (`held`), only when it is above zero, and the control events that asked (`trigger`). */
export function heldOf(story: DecisionStory): { readonly n: number; readonly kinds: string; readonly trigger: string } | undefined {
  const n = story.decision === undefined ? undefined : payload(story.decision)["held"];
  if (typeof n !== "number" || n <= 0) return undefined;
  const events = payload(story.request)["events"];
  const control = Array.isArray(events) ? (events as { kind?: unknown }[]).map((e) => String(e.kind)).filter((k) => !PERCEPTION_KINDS.includes(k)) : [];
  return { n, kinds: heldKinds(story.request).words, trigger: [...new Set(control)].join(", ") };
}

/** A decision that went on with the running action instead of starting it again: the action it went on with, and why (`mind.continued`, as the brain wrote it). */
export function continuedOf(story: DecisionStory): { readonly actionId: string; readonly name: string; readonly reason: string } | undefined {
  if (story.decision === undefined) return undefined;
  const p = payload(story.decision);
  if (p["continued"] !== true) return undefined;
  const self = payload(story.request)["self"] as { running?: { name?: unknown } | null } | undefined;
  const mind = p["mind"] as { continued?: unknown } | undefined;
  return { actionId: String(p["actionId"] ?? ""), name: typeof self?.running?.name === "string" ? self.running.name : "action", reason: typeof mind?.continued === "string" ? mind.continued : "" };
}

/** The wake policy the run's configuration gave this agent (`all` when the profile does not say). */
export async function wakeOf(ports: Ports, runId: string, agentId: string): Promise<"all" | "task"> {
  const config = (await ports.trace.query({ runId, agentId, kinds: ["lifecycle"], op: "config", limit: 4 }))[0];
  const wake = (config?.payload as { mindS2?: { effective?: { wake?: unknown } } } | undefined)?.mindS2?.effective?.wake;
  return wake === "task" ? "task" : "all";
}

/** The step a `task_step` record is about, with its status, outcome and code. */
const stepRec = (r: TraceRecord) => {
  const p = payload(r);
  return { step: Number(p["step"]), of: Number(p["of"]), status: String(p["status"]), outcome: typeof p["outcome"] === "string" ? p["outcome"] : undefined, code: typeof p["code"] === "string" ? p["code"] : undefined, actionId: typeof p["actionId"] === "string" ? p["actionId"] : undefined };
};

/** `goTo {"xM":40,"yM":60}` cut to a length. */
export const actionWords = (action: string | undefined, params: unknown, max = 44): string => {
  if (action === undefined) return "";
  const text = params === undefined || (typeof params === "object" && params !== null && Object.keys(params).length === 0) ? action : `${action} ${JSON.stringify(params)}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** The task list as the world held it at this decision, with how each step stands, where the list came from and how the last step ended; undefined while the agent has no list and the decision wrote none. */
export async function taskStoryOf(ports: Ports, runId: string, story: DecisionStory): Promise<TaskStory | undefined> {
  const agentId = story.agentId;
  const held = taskOfRequest(story.request);
  const writtenNow = story.taskRecords.written;
  if (held === undefined && writtenNow === undefined) return undefined;
  const lists = (await ports.trace.query({ runId, agentId, kinds: ["event"], op: "task", limit: 500 })).filter((r) => r.seq < story.request.seq).sort((a, b) => a.seq - b.seq);
  const stepRecords = (await ports.trace.query({ runId, agentId, kinds: ["event"], op: "task_step", limit: 2000 })).filter((r) => r.seq < story.request.seq).sort((a, b) => a.seq - b.seq);
  const decisionNo = (seq: number): number | undefined => {
    const before = story.decisions.filter((d) => d < seq).length;
    return before === 0 ? undefined : before;
  };
  // The step a decision names is the one its action was bound to: the `running` record it caused (the `task_step` records it caused for a step that ended, by preempting the action, are not named).
  const named = new Set(story.taskRecords.steps.filter((r) => stepRec(r).status === "running").map((r) => stepRec(r).step));

  /** The list this decision writes, as the world holds it once the decision has been applied: every step pending, except the one the decision bound to its action (running), which it names. */
  const writtenRows = (): TaskRow[] => {
    const bound = new Map(story.taskRecords.steps.map(stepRec).filter((s) => s.status === "running").map((s) => [s.step, s.actionId] as const));
    const steps = (payload(writtenNow as TraceRecord)["steps"] as { text: string; action?: string; params?: Record<string, unknown> }[] | undefined) ?? [];
    return steps.map((s, i) => {
      const running = bound.has(i + 1);
      const state: StepState = running ? "running" : "pending";
      return { n: i + 1, text: s.text, action: s.action, params: s.params, actionId: bound.get(i + 1), state, glyph: STEP_GLYPH[state], code: undefined, named: running };
    });
  };
  const countsOf = (rows: readonly TaskRow[]) => ({ total: rows.length, done: rows.filter((r) => r.state === "done").length, running: rows.filter((r) => r.state === "running").length, failed: rows.filter((r) => r.state === "failed" || r.state === "refused" || r.state === "preempted").length });
  const thisNo = story.decision === undefined ? undefined : story.decisions.indexOf(story.decision.seq) + 1 || undefined;

  if (held === undefined && writtenNow !== undefined) {
    // The first decision of a list: the world held none at its request; the list is the one this decision wrote.
    const rows = writtenRows();
    return { rows, counts: countsOf(rows), source: { kind: "written", at: thisNo, was: undefined, unchanged: false, byThisDecision: true }, last: undefined, stopped: undefined, fromThisDecision: true };
  }

  const list = held as NonNullable<typeof held>;
  const listRec = lists.at(-1);
  const previous = lists.at(-2);
  const since = stepRecords.filter((r) => listRec === undefined || r.seq > listRec.seq);
  const rows: TaskRow[] = list.steps.map((s, i) => {
    const n = i + 1;
    const mine = s.status === "failed" ? since.filter((r) => stepRec(r).step === n && stepRec(r).status === "failed").at(-1) : undefined;
    const info = mine === undefined ? undefined : stepRec(mine);
    const state = stateOf(s, info?.outcome);
    return { n, text: s.text, action: s.action, params: s.params, actionId: s.actionId, state, glyph: STEP_GLYPH[state], code: info?.code, named: named.has(n) };
  });
  const counts = countsOf(rows);
  const rewrittenNow = writtenNow !== undefined;
  if (rewrittenNow) {
    // A decision that rewrites the list: the section shows the list it writes (the step it names is a step of that list), and the list it replaces is kept apart, with nothing named in it.
    const fresh = writtenRows();
    return { rows: fresh, counts: countsOf(fresh), source: { kind: "rewritten", at: thisNo, was: list.steps.length, unchanged: false, byThisDecision: true }, last: undefined, stopped: undefined, fromThisDecision: true, before: { rows: rows.map((r) => ({ ...r, named: false })) } };
  }
  const source = {
    kind: previous === undefined ? ("written" as const) : ("rewritten" as const),
    at: listRec === undefined ? undefined : decisionNo(listRec.seq),
    was: previous === undefined ? undefined : ((payload(previous)["steps"] as unknown[] | undefined) ?? []).length,
    unchanged: !rewrittenNow,
    byThisDecision: false,
  };
  const lastRec = since.filter((r) => stepRec(r).status !== "running").at(-1);
  const last = list.last === undefined ? undefined : { text: `step ${list.last.step} ${STEP_GLYPH[list.last.status === "done" ? "done" : list.last.status === "preempted" ? "preempted" : list.last.status === "refused" ? "refused" : "failed"]} ${list.last.status === "done" ? "done" : list.last.status}${list.last.code === undefined ? "" : ` · ${list.last.code}`} · ${list.last.action}${lastRec === undefined || stepRec(lastRec).actionId === undefined ? "" : ` ${stepRec(lastRec).actionId}`}${lastRec === undefined ? "" : ` · at ${lastRec.simTime.toFixed(1)} s`}` };
  // The world never stops a mind's list: a failed step is only failed. The line is for the moment the last outcome is a failure and nothing has run since (no step running, none ended after it).
  const stopped = list.last !== undefined && list.last.status !== "done" && list.running === undefined ? `list stopped at step ${list.last.step} of ${rows.length}` : undefined;
  return { rows, counts, source, last, stopped, fromThisDecision: false };
}

/** The `held` of a decision record as the Log row ends it (` · held 3`), and its continuation (`↻ continued goTo act-000002`), for the rows that summarise a decision. */
export function decisionExtras(r: TraceRecord): { readonly held: number | undefined; readonly continued: boolean } {
  const p = payload(r);
  return { held: typeof p["held"] === "number" && p["held"] > 0 ? p["held"] : undefined, continued: p["continued"] === true };
}

export const isTaskRecord = (r: TraceRecord): boolean => r.kind === "event" && (opOf(r) === "task" || opOf(r) === "task_step");
