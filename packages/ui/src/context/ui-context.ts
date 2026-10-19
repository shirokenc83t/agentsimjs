import { create } from "zustand";

/** Kinds of things that can be selected anywhere in the UI (ADR-0016, ROADMAP appendix). */
export type SelectionKind = "agent" | "group" | "span" | "contract" | "planNode" | "cell";

export interface Selection {
  readonly kind: SelectionKind;
  readonly id: string;
}

export type RunViewMode = "live" | "replay";

/**
 * The shared UI context bus (ADR-0016): one time cursor, one run, one selection, read and written
 * by every panel so selecting anything synchronizes all views. UI-only state; never sim state.
 */
export interface UiContextState {
  readonly runId: string | undefined;
  /** `live`: the run in the sim worker (the cursor follows it). `replay`: a recorded run read from storage (the cursor is the user's). */
  readonly mode: RunViewMode;
  /** Time cursor in sim seconds. */
  readonly simTime: number;
  readonly selection: Selection | undefined;
  setRun(runId: string | undefined, mode?: RunViewMode): void;
  setSimTime(simTime: number): void;
  select(selection: Selection | undefined): void;
}

export function createUiContextStore() {
  return create<UiContextState>()((set) => ({
    runId: undefined,
    mode: "live",
    simTime: 0,
    selection: undefined,
    // Changing the run resets the cursor and selection: they belong to the previous run.
    setRun: (runId, mode = "live") => set({ runId, mode, simTime: 0, selection: undefined }),
    setSimTime: (simTime) => set({ simTime: Number.isFinite(simTime) && simTime >= 0 ? simTime : 0 }),
    select: (selection) => set({ selection }),
  }));
}

/** App-wide instance. */
export const useUiContext = createUiContextStore();
