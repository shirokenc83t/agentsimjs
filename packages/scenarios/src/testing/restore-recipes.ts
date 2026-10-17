import type { ScriptStep } from "@agentsim/core";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun, type PresetRunOptions } from "./preset-run.ts";
import type { RestoreRecipe } from "./restore-check.ts";

// The runs of the restore acceptance tests (F3a M1, T-003; plan M1: six kinds of run). Each recipe names the ticks to
// snapshot at; they were chosen from a scan of the run (momentFacts) to cover the case, and `restore-check.test.ts`
// asserts that each tick still shows it. The same recipes run short in `pnpm test` and long in the determinism project.

const goTo = (xM: number, yM: number): ScriptStep => ({ name: "goTo", params: { xM, yM } });
const takeoff: ScriptStep = { name: "takeoff", params: { altitudeM: 20 } };

/** The F1 demo's scripts: rover behind the wall and into the box, low far away, scout over the wall and back. */
const REFERENCE_SCRIPTS: Readonly<Record<string, readonly ScriptStep[]>> = {
  rover: [goTo(50, 10), goTo(50, 40)],
  low: [goTo(25, 60)],
  scout: [takeoff, goTo(50, 20), { name: "returnToBase", params: {} }],
};
const FAR_SCRIPTS: Readonly<Record<string, readonly ScriptStep[]>> = { rover: [goTo(50, 40)], low: [goTo(25, 60)] };

/** A two-stage strategy: A* with a budget of 150 expansions, then HPA*. At 100 expansions a tick the first stage ends in two ticks. */
const FALLBACK = { schemaVersion: 0, id: "fallback-restore", version: 1, root: { kind: "fallback", stages: [{ kind: "algorithm", algorithm: "astar", stageBudget: 150 }, { kind: "algorithm", algorithm: "hpa" }] } };
/** A lazy refine: HPA* coarse path, A* legs handed to the action as they complete (ADR-0037 fourth addition). */
const LAZY = { schemaVersion: 0, id: "lazy-restore", version: 1, root: { kind: "refine", mode: "lazy", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } };
const planning = (strategy: unknown) => ({ planning: { default: { strategy, onboardComputeExpansionsPerTick: 100 } } }) as unknown as Partial<RunConfigDocument>;

function recipe(name: string, options: PresetRunOptions, endTick: number, snapshotTicks: readonly number[]): RestoreRecipe {
  return { name, create: (mode) => buildPresetRun(options, mode), endTick, snapshotTicks };
}

/** The six kinds of run of the plan, plus hold and takeoff. `long` lengthens them for the determinism project. */
function recipes(long: boolean): RestoreRecipe[] {
  const s = (short: number, longer: number) => (long ? longer : short);
  return [
    // 1. A plain run: script brains, ideal beliefs. Early (planning), mid-action, and a UAV landing.
    recipe("plain-f1-demo", { preset: "f1-demo", scripts: REFERENCE_SCRIPTS }, s(450, 1500), long ? [1, 60, 330, 900] : [1, 60, 250, 330]),
    // 2. Timers and decision requests outstanding when the snapshot is taken (lockstep), timers active.
    recipe("timers-and-pending-requests", { preset: "f1-demo", scripts: REFERENCE_SCRIPTS, timed: ["rover", "low", "scout"] }, s(300, 1200), long ? [10, 160, 250, 800] : [10, 160, 250]),
    // 3. Explore on an unknown map: frontiers, unreachable marks, a belief change the planner has not seen, a back-off.
    recipe(
      "explore-unknown-map",
      { preset: "f2-discovery", scripts: { rover: [{ name: "explore", params: {} }], low: [goTo(25, 60)], scout: [takeoff, { name: "explore", params: {} }] } },
      s(650, 1500),
      long ? [20, 140, 360, 580, 1100] : [20, 140, 360, 580],
    ),
    // 4. A strategy query mid stage 1 and mid stage 2.
    recipe("strategy-mid-stage", { preset: "f2-discovery", scripts: FAR_SCRIPTS, runConfig: planning(FALLBACK) }, s(200, 1000), long ? [2, 5, 26, 130, 600] : [2, 5, 26, 130]),
    // 5. A lazy goTo mid-leg (legs still being planned while the vehicle moves).
    recipe("lazy-goto-mid-leg", { preset: "f2-discovery", scripts: FAR_SCRIPTS, runConfig: planning(LAZY) }, s(200, 1000), long ? [22, 48, 75, 106, 500] : [22, 48, 75, 106]),
    // 6. The belief-map prior run (f2-prior-1km config: the rover starts from the survey, the scout from an unknown map).
    recipe(
      "belief-map-prior-1km",
      { preset: "f2-prior-1km", scripts: { rover: [goTo(600, 500)], scout: [{ name: "takeoff", params: { altitudeM: 20 } }, goTo(900, 900)] } },
      s(300, 1200),
      long ? [1, 85, 200, 700] : [1, 85, 200],
    ),
    // Hold and takeoff in progress (a UGV holding while a UAV climbs; the UAV holding after its climb).
    recipe(
      "hold-and-takeoff",
      { preset: "f1-demo", scripts: { rover: [{ name: "hold", params: { durationS: 4 } }, goTo(50, 10)], scout: [takeoff, { name: "hold", params: { durationS: 6 } }, goTo(50, 20)] } },
      s(260, 1000),
      long ? [10, 60, 130, 500] : [10, 60, 130],
    ),
  ];
}

export const SHORT_RECIPES: readonly RestoreRecipe[] = recipes(false);

/** Twenty ground vehicles, each to its own target in the left part of the F1 world (free of the wall, box and marsh). */
function twentyAgents(): RestoreRecipe {
  const scripts: Record<string, readonly ScriptStep[]> = {};
  for (let i = 0; i < 20; i++) scripts[`u${String(i + 1).padStart(2, "0")}`] = [goTo(27, 4 + i * 3)];
  return recipe("twenty-agents", { preset: "f2-20-agents", scripts }, 1800, [300, 1100]);
}

/** Runs of at least 1,000 ticks, including 20 agents: for the determinism project. */
export const LONG_RECIPES: readonly RestoreRecipe[] = [...recipes(true), twentyAgents()];
