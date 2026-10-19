import type { ScriptStep } from "@agentsim/core";
import type { RunConfigDocument } from "../run-config/schema.ts";
import { buildPresetRun, type PresetRunOptions } from "./preset-run.ts";
import type { RestoreRecipe } from "./restore-check.ts";
import type { ReferenceRun } from "./reference-run.ts";

// The runs of the restore acceptance tests (F3a M1; plan M1: six kinds of run). Each recipe names the ticks to
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

function recipe(name: string, options: PresetRunOptions, endTick: number, snapshotTicks: readonly number[], afterTick?: RestoreRecipe["afterTick"]): RestoreRecipe {
  return { name, create: (mode) => buildPresetRun(options, mode), endTick, snapshotTicks, ...(afterTick ? { afterTick } : {}) };
}

/** Reads a private field of a service by name (a test helper: the recipes look at queries in flight to place a belief change). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (o: unknown, key: string): any => (o === undefined || o === null ? undefined : (o as Record<string, unknown>)[key]);

/** The chunks the search of a query in flight has read so far (plain: its engine; strategy: completed searches and the current stage). */
function readFlags(q: unknown): (Uint8Array | undefined)[] {
  const st = priv(q, "strat");
  if (!st) return [priv(q, "cached") ? priv(priv(q, "cached"), "readChunks") : priv(priv(q, "engine"), "readChunks")];
  const stage = priv(st, "stage");
  return [priv(st, "readUnion"), stage ? (priv(stage, "cached") ? priv(priv(stage, "cached"), "readChunks") : priv(priv(stage, "engine"), "readChunks")) : undefined];
}

/**
 * A belief change at the end of a tick, as a bump (a contact observation, the way a collision reaches the beliefs) followed by the
 * tail of the sensing phase (the planner's sync point and the topology update). It lands in a chunk the first query in flight has
 * read (`through`: the query will restart) or in one it has not (`away`: it will continue), so a snapshot taken at that tick finds
 * the query with a pending change of either kind. Nothing happens when no query is in flight.
 */
function beliefChange(kind: "through" | "away"): (run: ReferenceRun) => void {
  return (run) => {
    const active = priv(run.planner.service, "active") as Map<string, unknown>;
    for (const agentId of [...active.keys()].sort()) {
      const q = active.get(agentId);
      const flags = readFlags(q);
      if (flags.every((f) => f === undefined)) continue;
      const g = priv(priv(q, "views"), "space").grid;
      const count = g.chunksX * g.chunksY;
      let k = -1;
      for (let c = 0; c < count && (kind === "through" ? k < 0 : true); c++) {
        const read = flags.some((f) => f?.[c] === 1);
        if (kind === "through" ? read : !read) k = c; // `away`: the last chunk not read
      }
      if (k < 0) continue;
      const cs = g.chunkSize;
      const i = (k % g.chunksX) * cs + (cs >> 1);
      const j = Math.floor(k / g.chunksX) * cs + (cs >> 1);
      const simTimeS = run.world.simTimeS;
      run.sensing.contact(agentId, [i, j], 0, simTimeS);
      run.planner.syncViews();
      run.topology.update(simTimeS);
      return;
    }
  };
}

/** Belief changes at the end of the given ticks. */
const changesAt = (changes: Readonly<Record<number, "through" | "away">>): RestoreRecipe["afterTick"] => {
  const apply = { through: beliefChange("through"), away: beliefChange("away") };
  return (run, tick) => {
    const kind = changes[tick];
    if (kind) apply[kind](run);
  };
};

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
      { preset: "f2-discovery", scripts: { rover: [{ name: "explore", params: {} }], low: [goTo(25, 60)], scout: [takeoff, { name: "explore", params: {} }] }, beliefVsTruth: { everyS: 1 } },
      s(650, 1500),
      long ? [20, 140, 179, 355, 590, 1100] : [20, 140, 179, 355, 590],
      changesAt({ 140: "through", 179: "away" }),
    ),
    // 4. A strategy query mid stage 1 and mid stage 2.
    recipe(
      "strategy-mid-stage",
      { preset: "f2-discovery", scripts: FAR_SCRIPTS, runConfig: planning(FALLBACK) },
      s(200, 1000),
      long ? [2, 3, 5, 26, 33, 130, 600] : [2, 3, 5, 26, 33, 130],
      changesAt({ 26: "through", 33: "away" }),
    ),
    // 5. A lazy goTo mid-leg (legs still being planned while the vehicle moves).
    recipe("lazy-goto-mid-leg", { preset: "f2-discovery", scripts: FAR_SCRIPTS, runConfig: planning(LAZY) }, s(200, 1000), long ? [22, 48, 75, 106, 500] : [22, 48, 75, 106]),
    // 6. The belief-map prior run (f2-prior-1km config: the rover starts from the survey, the scout from an unknown map).
    recipe(
      "belief-map-prior-1km",
      { preset: "f2-prior-1km", scripts: { rover: [goTo(600, 500)], scout: [{ name: "takeoff", params: { altitudeM: 20 } }, goTo(900, 900)] } },
      s(300, 1200),
      long ? [1, 85, 200, 700] : [1, 85, 200],
    ),
    // Cruise altitudes that are not the body's (20 m): a takeoff to 30 m, a goTo at 25 m, then an explore that keeps the 25 m it started at.
    // A restore that asked for another altitude would plan on another view and the run would diverge. The observer is on.
    recipe(
      "uav-altitudes",
      {
        preset: "f2-discovery",
        scripts: {
          rover: [goTo(50, 40)],
          low: [goTo(25, 60)],
          scout: [{ name: "takeoff", params: { altitudeM: 30 } }, { name: "goTo", params: { xM: 50, yM: 20, altitudeM: 25 } }, { name: "explore", params: {} }],
        },
        beliefVsTruth: { everyS: 1 },
      },
      s(420, 1000),
      long ? [100, 190, 300, 700] : [100, 190, 300],
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
