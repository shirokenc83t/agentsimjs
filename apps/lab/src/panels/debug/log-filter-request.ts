import { useSyncExternalStore } from "react";

// A filter another panel asks the Log to show (the agent history's "Log: this agent, window"): the Log holds its filter text itself, so the request is a numbered message it applies once.

export interface LogFilterRequest {
  readonly id: number;
  readonly text: string;
}

let state: LogFilterRequest = { id: 0, text: "" };
let taken = 0;
const listeners = new Set<() => void>();

export function requestLogFilter(text: string): void {
  state = { id: state.id + 1, text };
  for (const l of listeners) l();
}

/** The request nobody applied yet (once): the Log that is opened by the request takes it when it mounts, the one that is open when it is made takes it at once. */
export function takeLogFilterRequest(): string | undefined {
  if (state.id === taken) return undefined;
  taken = state.id;
  return state.text;
}

export const getLogFilterRequest = (): LogFilterRequest => state;

export function useLogFilterRequest(): LogFilterRequest {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getLogFilterRequest,
    getLogFilterRequest,
  );
}
