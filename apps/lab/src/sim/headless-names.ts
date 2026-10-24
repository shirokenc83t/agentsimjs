// What a headless re-run is called (the label of the run, the button, its tip): pure text, shared by the shell, the run popover and the run controller.

const RERUN_MARK = " · re-run of ";
/** A run's label without the mark of a re-run (a re-run of a re-run is a re-run of the scenario's run, not a chain of marks). */
export const baseLabel = (label: string): string => (label.includes(RERUN_MARK) ? label.slice(0, label.indexOf(RERUN_MARK)) : label);
/** The label of a headless re-run: what it is a re-run of, and how many of that run's commands were applied again (the run popover, the monitor and Storage show it). */
export const rerunLabel = (label: string, ofRunId: string, commands: number): string => `${baseLabel(label)}${RERUN_MARK}${ofRunId} · ${commands} command${commands === 1 ? "" : "s"} re-applied`;
/** What the "headless" button of a run with `commands` recorded commands is called, and says. */
export const headlessButton = (commands: number): string => (commands > 0 ? "Re-run headless" : "Run headless");
export const headlessTip = (commands: number, runId: string | undefined): string =>
  commands > 0 ? `Same scenario version, run configuration, seed and the ${commands} command${commands === 1 ? "" : "s"} of ${runId ?? "this run"}; no live view, as fast as lockstep allows, always recorded` : "No commands to re-apply: the scenario from its start, with no live view, as fast as lockstep allows, always recorded";

