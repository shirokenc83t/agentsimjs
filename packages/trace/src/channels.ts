import { parseSource } from "./source.ts";
import type { TraceKind, TraceRecord } from "./trace-record.ts";

// The channels of a recording and the closed mapping of every record to exactly one of them (ADR-0035 §1, addition of
// 2026-10-17, item 1). The mapping is keyed by (kind, source component, `op` where needed).

export const CHANNELS = ["events", "transitions", "protocol", "compute", "mind-io", "poses", "beliefs", "metrics", "health", "sensors", "checkpoints"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelRule {
  readonly kind: TraceKind;
  /** The source's component (`body` of `uav-001/body`); any when absent. */
  readonly component?: string;
  /** The payload's `op`; any when absent. */
  readonly op?: string;
  readonly channel: Channel;
}

/**
 * The table. A record takes the most specific rule that matches it (kind, component and op, then kind and op, then kind and
 * component, then kind alone), so the order of the rows does not matter. A kind with no row is unmapped: the plan-DSL and policy
 * uses of `plan` and `policy` (F5, F9), protocols, contracts and groups are added by the phases that emit them.
 */
export const CHANNEL_RULES: readonly ChannelRule[] = [
  // events: what happened (ADR-0035 §1), every op unless a row below says otherwise
  { kind: "event", channel: "events" },
  { kind: "action", channel: "events" }, // start, end, outcome and the other ops of a running action
  { kind: "reflex", channel: "events" },
  { kind: "injected", channel: "events" },
  { kind: "degradation", channel: "events" },
  { kind: "lifecycle", channel: "events" },
  { kind: "observation", channel: "events" }, // sensor contacts
  { kind: "detector", channel: "events" },
  { kind: "message", channel: "events" }, // F4
  { kind: "escalation", channel: "events" }, // F4
  { kind: "thought", op: "decision", channel: "events" }, // what a mind decided; the request it answered is `mind-io`
  // transitions: the notes of a running action (item 3), plan nodes, policy rules fired
  { kind: "action", op: "hold", channel: "transitions" },
  { kind: "action", op: "leg", channel: "transitions" },
  { kind: "action", op: "replan", channel: "transitions" },
  { kind: "plan-node", channel: "transitions" },
  { kind: "policy-rule", channel: "transitions" },
  // compute: algorithm queries, and the plan records that carry a query's geometry (ADR-0037)
  { kind: "compute", channel: "compute" },
  { kind: "plan", channel: "compute" },
  // mind-io: requests and the space summaries they refer to (item 2)
  { kind: "thought", op: "request", channel: "mind-io" },
  { kind: "thought", op: "space", channel: "mind-io" },
  // mind-io in F4 (ADR-0035 addition of 2026-10-29): each model call with its prompt and answer, the fallback after the retries, a miss of a strict replay, the flag of a run that stopped being
  // reproducible, and the limit warnings, hits and raises (an op of its own each, from `<agent>/s2` or the run's own source).
  { kind: "thought", op: "llm-call", channel: "mind-io" },
  { kind: "thought", op: "fallback", channel: "mind-io" },
  { kind: "thought", op: "cache-miss", channel: "mind-io" },
  { kind: "thought", op: "not-reproducible", channel: "mind-io" },
  { kind: "thought", op: "limit-warning", channel: "mind-io" },
  { kind: "thought", op: "limit-hit", channel: "mind-io" },
  { kind: "thought", op: "limit-raised", channel: "mind-io" },
  // poses: samples from the agent's body (item 9)
  { kind: "observation", component: "body", op: "pose", channel: "poses" },
  // beliefs: the observer's samples (item 4)
  { kind: "event", op: "belief-vs-truth", channel: "beliefs" },
  // checkpoints: checkpoint records and snapshot records (item 8)
  { kind: "snapshot", channel: "checkpoints" },
  { kind: "event", component: "sim", op: "checkpoint", channel: "checkpoints" },
];

const BY_KIND = new Map<string, ChannelRule[]>();
for (const r of CHANNEL_RULES) BY_KIND.set(r.kind, [...(BY_KIND.get(r.kind) ?? []), r]);

/** The channel of a record, or undefined when the table does not map it. */
export function channelOf(r: Pick<TraceRecord, "kind" | "source" | "payload">): Channel | undefined {
  const rules = BY_KIND.get(r.kind);
  if (!rules) return undefined;
  const component = parseSource(r.source)?.component;
  const p = r.payload;
  const op = p !== null && typeof p === "object" ? (p as { op?: unknown }).op : undefined;
  let best: ChannelRule | undefined;
  let bestScore = -1;
  for (const rule of rules) {
    if (rule.component !== undefined && rule.component !== component) continue;
    if (rule.op !== undefined && rule.op !== op) continue;
    const score = (rule.op === undefined ? 0 : 2) + (rule.component === undefined ? 0 : 1);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best?.channel;
}
