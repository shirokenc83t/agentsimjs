import { useSyncExternalStore } from "react";

// The commands given to the run and not yet applied (U-011 section 5): a command takes effect at a tick, so one given while the run is paused or waiting is in the queue until the
// next tick. The researcher's controls put them here when they send one; what is queued is read against the sim clock (an entry is over once a tick has run after it), so nothing
// has to clear it.

export interface QueuedCommand {
  readonly agentId: string;
  readonly op: string;
  /** The sim time at which it was given. */
  readonly atS: number;
}

let queue: readonly QueuedCommand[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function queueCommand(c: QueuedCommand): void {
  queue = [...queue.filter((q) => !(q.agentId === c.agentId && q.op === c.op)), c].slice(-20);
  emit();
}

/** What is still waiting for a tick at this sim time. */
export const pendingAt = (q: readonly QueuedCommand[], simTimeS: number): readonly QueuedCommand[] => q.filter((c) => simTimeS <= c.atS + 1e-9);

export const useQueuedCommands = (): readonly QueuedCommand[] =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => queue,
  );

/** For tests: empties the queue. */
export function clearQueuedCommands(): void {
  queue = [];
  emit();
}
