import { create } from "zustand";

/** Kinds of things that can be selected anywhere in the UI (ADR-0016, ROADMAP appendix). */
export type SelectionKind = "agent" | "group" | "span" | "contract" | "planNode" | "cell";

export interface Selection {
  readonly kind: SelectionKind;
  readonly id: string;
}

export type RunViewMode = "live" | "replay";

/** A range of sim time the researcher selected on the Timeline (seconds): what "Re-simulate this window" and the log's export act on. */
export interface TimeSelection {
  readonly t0S: number;
  readonly t1S: number;
}

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
  /** The time range selected on the Timeline, or none. It belongs to a run: a new run clears it. */
  readonly timeSelection: TimeSelection | undefined;
  setRun(runId: string | undefined, mode?: RunViewMode): void;
  setSimTime(simTime: number): void;
  select(selection: Selection | undefined): void;
  setTimeSelection(selection: TimeSelection | undefined): void;
}

export function createUiContextStore() {
  return create<UiContextState>()((set) => ({
    runId: undefined,
    mode: "live",
    simTime: 0,
    selection: undefined,
    timeSelection: undefined,
    // Changing the run resets the cursor and selection: they belong to the previous run.
    setRun: (runId, mode = "live") => set({ runId, mode, simTime: 0, selection: undefined, timeSelection: undefined }),
    setSimTime: (simTime) => set({ simTime: Number.isFinite(simTime) && simTime >= 0 ? simTime : 0 }),
    select: (selection) => set({ selection }),
    // A range that does not run forward is no selection; the ends are ordered and never negative.
    setTimeSelection: (sel) =>
      set({
        timeSelection:
          sel !== undefined && Number.isFinite(sel.t0S) && Number.isFinite(sel.t1S) && sel.t1S > sel.t0S
            ? { t0S: Math.max(0, sel.t0S), t1S: sel.t1S }
            : undefined,
      }),
  }));
}

/** App-wide instance. */
export const useUiContext = createUiContextStore();
