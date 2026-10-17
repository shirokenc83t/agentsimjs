import type { StrategyTestResult } from "@agentsim/scenarios";
import { useSyncExternalStore } from "react";

/** The Strategy test's last result for an agent: the Inspector's section shows it, the Scene's sandbox overlay draws it. */
export interface SandboxView {
  readonly agentId: string;
  readonly result: StrategyTestResult;
}

/** The sandbox's target, picked on the map (the Scene's next ground click while `picking`) or typed in the section. */
export interface SandboxTarget {
  readonly picking: boolean;
  readonly target: { readonly xM: number; readonly yM: number } | undefined;
}

function store<T>(initial: T) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: T): void {
      if (Object.is(next, current)) return;
      current = next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/**
 * Two small stores beside the UI context (ADR-0016), in the lazy panels' module graph: which sandbox result is on show, and
 * the sandbox's target gesture. Nothing here reaches the worker or a run input.
 */
const view = store<SandboxView | undefined>(undefined);
const target = store<SandboxTarget>({ picking: false, target: undefined });

export const sandboxView = { get: view.get, set: view.set, subscribe: view.subscribe };
export const sandboxTarget = {
  get: target.get,
  subscribe: target.subscribe,
  /** The next ground click in the Scene becomes the target. */
  startPicking: () => target.set({ ...target.get(), picking: true }),
  cancelPicking: () => (target.get().picking ? target.set({ ...target.get(), picking: false }) : undefined),
  setTarget: (xM: number, yM: number) => target.set({ picking: false, target: { xM, yM } }),
};

export const useSandboxView = (): SandboxView | undefined => useSyncExternalStore(view.subscribe, view.get);
export const useSandboxTarget = (): SandboxTarget => useSyncExternalStore(target.subscribe, target.get);
