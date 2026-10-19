import type { TraceQuery } from "./ports.ts";

/** A window of pose samples of a run: sim times (inclusive), one agent or all of them, paged by seq. */
export interface PoseWindow {
  readonly runId: string;
  readonly from: number;
  readonly to: number;
  readonly agentId?: string;
  readonly afterSeq?: number;
  readonly limit: number;
}

/**
 * The trace query of a pose window (ADR-0035 item 9: pose samples are `observation` records of `<agent>/body` whose payload op is `pose`).
 * The window maps to a seq range, the body component index serves the rest, in seq order; the Replay builds its interpolation from them.
 */
export function poseWindowQuery(w: PoseWindow): TraceQuery {
  return {
    runId: w.runId,
    limit: w.limit,
    simTime: { from: w.from, to: w.to },
    kinds: ["observation"],
    op: "pose",
    source: { include: [{ owner: w.agentId ?? null, component: "body" }] },
    ...(w.afterSeq === undefined ? {} : { afterSeq: w.afterSeq }),
  };
}
