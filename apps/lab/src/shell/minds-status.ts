import type { SimMindsMessage } from "@agentsim/core";
import { useSyncExternalStore } from "react";
import type { LimitName } from "./minds-limits.ts";

// What the System 2 minds of the run are doing, as the sim worker last told (F4, T-110): the player's tiles, the status bar's chips, the notice and the dialog all read this one store. It also keeps what
// is the main thread's own: since when a decision has been waiting (a wall-clock figure for the note under the clock) and which 80 % warnings have been shown as a notice (once each, for 8 s).

export interface MindsView {
  readonly status: SimMindsMessage | undefined;
  /** Wall time (performance.now) at which the minds began to be waited for, while they are. */
  readonly waitingSinceMs: number | undefined;
  /** The warning notice to show now (each warning is shown once, without buttons, and closes after `WARNING_NOTICE_MS`). */
  readonly warningNotice: { readonly agentId: string; readonly limit: LimitName; readonly pct: number; readonly shownAtMs: number } | undefined;
}

export const WARNING_NOTICE_MS = 8000;

const EMPTY: MindsView = { status: undefined, waitingSinceMs: undefined, warningNotice: undefined };
let view: MindsView = EMPTY;
const listeners = new Set<() => void>();
const shown = new Set<string>();

const emit = () => {
  for (const l of listeners) l();
};

/** A status from the worker. A different run starts again; a warning not shown yet becomes the notice; the wait is timed from the first status that has a decision waiting. */
export function setMinds(m: SimMindsMessage, nowMs = performance.now()): void {
  if (view.status !== undefined && view.status.runId !== m.runId) {
    shown.clear();
    view = EMPTY;
  }
  let warningNotice = view.warningNotice;
  for (const a of m.agents) {
    for (const w of a.warnings) {
      const key = `${m.runId}|${a.agentId}|${w.limit}|${a.limits[w.limit]}`;
      if (shown.has(key)) continue;
      shown.add(key);
      warningNotice = { agentId: a.agentId, limit: w.limit, pct: w.pct, shownAtMs: nowMs };
    }
  }
  const waitingSinceMs = m.waiting > 0 ? (view.waitingSinceMs ?? nowMs) : undefined;
  view = { status: m, waitingSinceMs, warningNotice };
  emit();
}

/** The warning notice has been up for its time (or was closed). */
export function closeWarningNotice(): void {
  if (view.warningNotice === undefined) return;
  view = { ...view, warningNotice: undefined };
  emit();
}

/** The run is gone (another is loaded, or none). */
export function clearMinds(): void {
  shown.clear();
  view = EMPTY;
  emit();
}

export const getMinds = (): MindsView => view;

export function useMinds(): MindsView {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getMinds,
    getMinds,
  );
}
