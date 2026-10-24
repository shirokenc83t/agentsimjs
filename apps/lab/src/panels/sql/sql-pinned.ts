import type { SqlResult } from "@agentsim/storage";
import { useSyncExternalStore } from "react";

// The result a researcher pinned in its own window (U-010 section 5): it stays there while the console runs the next statement. One pinned result at a time, in memory.

export interface PinnedResult {
  readonly result: SqlResult;
  /** The statement that made it. */
  readonly sql: string;
  readonly at: number;
}

let pinned: PinnedResult | undefined;
const listeners = new Set<() => void>();

export function pinSqlResult(result: SqlResult, sql: string): void {
  pinned = { result, sql, at: Date.now() };
  for (const l of listeners) l();
}

export const usePinnedSqlResult = (): PinnedResult | undefined =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pinned,
  );
