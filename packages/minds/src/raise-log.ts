import type { LimitEvent, LimitName, LlmBrainHooks } from "./llm-brain.ts";

// A raise of a limit is a researcher input: the record (`lifecycle`, op `raiseLimit`: the limit, the value before, the value after, the tick) is what replays it (ADR-0044 section 5). A replay reads the raises
// of the run it replays and answers the same hit with the same raise, with no one asked.

export interface RaiseEntry {
  readonly agentId: string;
  readonly limit: LimitName;
  readonly tick: number;
  readonly value: number;
}

/** The raises a run's records hold, in order. */
export function raisesFromRecords(records: readonly { readonly kind: string; readonly agentId?: string; readonly payload: unknown }[]): RaiseEntry[] {
  const out: RaiseEntry[] = [];
  for (const r of records) {
    if (r.kind !== "lifecycle" || r.agentId === undefined) continue;
    const p = r.payload as { op?: unknown; limit?: unknown; after?: unknown; tick?: unknown } | null;
    if (p?.op !== "raiseLimit" || typeof p.limit !== "string" || typeof p.after !== "number" || typeof p.tick !== "number") continue;
    out.push({ agentId: r.agentId, limit: p.limit as LimitName, tick: p.tick, value: p.after });
  }
  return out;
}

/** The hooks of a replay: a hit that the log has a raise for (same agent, limit and tick) is answered with it; any other hit stops the run, as a run with no one to ask does. */
export function replayRaises(log: readonly RaiseEntry[]): LlmBrainHooks {
  return {
    onLimitHit(e: LimitEvent) {
      const hit = log.find((x) => x.agentId === e.agentId && x.limit === e.limit && x.tick === e.tick);
      return Promise.resolve(hit === undefined ? ({ action: "stop" } as const) : ({ action: "raise", value: hit.value } as const));
    },
  };
}
