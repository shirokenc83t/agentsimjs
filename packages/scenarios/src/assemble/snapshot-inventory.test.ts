import { runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun, type ReferenceRun } from "../testing/reference-run.ts";
import { NOT_STATE, STATE_INVENTORY as COMMON_INVENTORY, type ClassInventory, type StateItem } from "./snapshot-inventory.ts";

const WIRING = "wiring: constructed again when the run is assembled";
const item = (treatment: StateItem["treatment"], note: string): StateItem => ({ treatment, note });

/**
 * The observer-side beliefs-vs-truth class, classified here because ADR-0005's boundary test lets only its own module, its
 * export and createRun name it in non-test sources. T-005: `dueS` is captured and the rest is rebuilt.
 */
const OBSERVER_INVENTORY: Readonly<Record<string, ClassInventory>> = {
  BeliefVsTruth: {
    truth: item("rebuilt", "ground truth"),
    objects: item("rebuilt", "scenario"),
    sensing: item("rebuilt", WIRING),
    sink: item("rebuilt", WIRING),
    everyS: item("rebuilt", "run configuration"),
    trackers: item("rebuilt", "incremental tallies: rebuilt by recompute (they equal a full count)"),
    order: item("rebuilt", "run configuration"),
    labelsByKey: item("rebuilt", "connected components of the ground truth: derived"),
    byId: item("rebuilt", WIRING),
    classes: item("scratch", "buffer"),
    dueS: item("captured", "the sim time of each agent's next sample: decides when the observer's trace records appear"),
  },
};

const STATE_INVENTORY: Readonly<Record<string, ClassInventory>> = { ...COMMON_INVENTORY, ...OBSERVER_INVENTORY };

// F3a M1, T-002: the inventory of a run's mutable state (ADR-0035 addition of 2026-10-17, item 8). The table lives in
// snapshot-inventory.ts; this test keeps it true. It walks the objects of real runs and fails when
//   - a class reachable from a run is in neither STATE_INVENTORY nor NOT_STATE,
//   - an object has a field the inventory does not classify as captured, rebuilt or scratch,
//   - the inventory lists a field that no sampled object has any more,
// Closures cannot be walked: CLOSURE_STATE names the ones known today (T-004 turns the ones that matter into data);
// tools/test/snapshot-inventory-closures.test.ts checks that each is still in the source.

const priv = (o: unknown, key: string): unknown => (o === undefined || o === null ? undefined : (o as Record<string, unknown>)[key]);
const values = (m: unknown): unknown[] => (m instanceof Map ? [...m.values()] : Array.isArray(m) ? m : []);

interface Seen {
  readonly keys: Set<string>;
  count: number;
}
type Sample = Map<string, Seen>;

function note(sample: Sample, name: string, o: object): void {
  const e = sample.get(name) ?? { keys: new Set<string>(), count: 0 };
  e.count++;
  for (const k of Object.keys(o)) e.keys.add(k);
  sample.set(name, e);
}

/** Every class instance reachable from the run (own enumerable properties, Maps, Sets and arrays), by constructor name. */
function walkClasses(root: unknown, sample: Sample): void {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object" || seen.has(v) || ArrayBuffer.isView(v)) continue;
    seen.add(v);
    if (v instanceof Map) {
      for (const x of v.values()) stack.push(x);
      continue;
    }
    if (v instanceof Set || Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    const name = (v as { constructor?: { name?: string } }).constructor?.name ?? "?";
    if (name !== "Object") {
      note(sample, name, v);
      if (name in NOT_STATE) continue; // ground truth and derived engines are not walked
    }
    for (const x of Object.values(v)) stack.push(x);
  }
}

/** Plain-object shapes with no class: reached through the owner's field, whichever the moment of the run. */
function walkShapes(run: ReferenceRun, sample: Sample): void {
  const add = (name: string, objects: readonly unknown[]) => {
    for (const o of objects) if (o !== null && typeof o === "object") note(sample, name, o);
  };
  add("SimAgent", run.agents);
  add("UgvState", run.agents.filter((a) => a.kind === "ugv").map((a) => a.state));
  add("UavState", run.agents.filter((a) => a.kind === "uav").map((a) => a.state));
  add("BatteryState", run.agents.map((a) => a.battery));
  add("Pending", values(priv(run.world, "slots")).filter((p) => p !== undefined));
  add("Active", values(priv(run.runtime, "active")));
  add("ActionInfo", values(priv(run.runtime, "last")));
  const sensing = values(priv(run.sensing, "byId"));
  add("AgentSensing", sensing);
  add("SensorState", sensing.flatMap((a) => values(priv(a, "sensors"))));
  add("EntityBelief", sensing.flatMap((a) => values(priv(a, "entities"))));
  add("Marks", values(priv(run.topology, "marks")));
  add("ActiveQuery", values(priv(run.planner.service, "active")));
  add("Tracker", values(priv(run.observer, "trackers")));
}

function sampleRun(sample: Sample, run: ReferenceRun): void {
  walkClasses(run, sample);
  walkShapes(run, sample);
}

const BELIEFS_UNKNOWN = { beliefs: { default: { init: "unknown" as const } } };

/** Samples at several moments of three runs: ideal agents, belief agents with an observer, and an explore run. */
async function sampleAll(): Promise<Sample> {
  const sample: Sample = new Map();

  const ideal = buildReferenceRun();
  for (const ticks of [3, 197, 400]) {
    await runLockstep(ideal.world, ideal.scheduler, ticks);
    sampleRun(sample, ideal);
  }

  const belief = buildReferenceRun({ runConfig: BELIEFS_UNKNOWN, beliefVsTruth: { everyS: 1 } });
  for (const ticks of [3, 47, 350, 600]) {
    await runLockstep(belief.world, belief.scheduler, ticks);
    sampleRun(sample, belief);
  }

  const explore = buildReferenceRun({
    runConfig: BELIEFS_UNKNOWN,
    scripts: {
      rover: [{ name: "explore", params: {} }],
      low: [{ name: "hold", params: { durationS: 5 } }, { name: "goTo", params: { xM: 25, yM: 60 } }],
      scout: [{ name: "takeoff", params: { altitudeM: 20 } }, { name: "explore", params: {} }],
    },
    beliefVsTruth: { everyS: 2 },
  });
  for (const ticks of [5, 95, 400, 800]) {
    await runLockstep(explore.world, explore.scheduler, ticks);
    sampleRun(sample, explore);
  }
  return sample;
}

function classify(inv: ClassInventory, field: string): StateItem | undefined {
  return inv[field] ?? inv["*"];
}

describe("snapshot state inventory (F3a M1, T-002)", () => {
  let sample: Sample;
  const get = async () => (sample ??= await sampleAll());

  it("knows every class a run holds: each is state (classified field by field) or declared not to be", async () => {
    const s = await get();
    const unknown = [...s.keys()].filter((name) => !(name in STATE_INVENTORY) && !(name in NOT_STATE)).sort();
    expect(unknown, `classes reachable from a run that the inventory does not know: add them to STATE_INVENTORY or NOT_STATE in snapshot-inventory.ts`).toEqual([]);
  }, 120_000);

  it("classifies every field of every class and shape as captured, rebuilt or scratch", async () => {
    const s = await get();
    const missing: string[] = [];
    for (const [name, seen] of s) {
      const inv = STATE_INVENTORY[name];
      if (!inv) continue;
      for (const k of [...seen.keys].sort()) if (!classify(inv, k)) missing.push(`${name}.${k}`);
    }
    expect(missing, `fields that gained a place in run state without a classification (add them to snapshot-inventory.ts)`).toEqual([]);
  }, 120_000);

  it("lists no field that no sampled object has any more", async () => {
    const s = await get();
    const stale: string[] = [];
    for (const [name, inv] of Object.entries(STATE_INVENTORY)) {
      const seen = s.get(name);
      if (!seen) continue; // classes a run does not always hold are checked by the next test
      for (const [field, item] of Object.entries(inv)) {
        if (field === "*" || item.optional || seen.keys.has(field)) continue;
        stale.push(`${name}.${field}`);
      }
    }
    expect(stale, `inventory entries for fields that no longer exist (remove or rename them)`).toEqual([]);
  }, 120_000);

  it("has sampled the classes that carry the run's behaviour, so the checks above mean something", async () => {
    const s = await get();
    const required = [
      "World",
      "Inbox",
      "ScriptBrain",
      "Clock",
      "Scheduler",
      "ActionRuntime",
      "GoToBehavior",
      "ExploreBehavior",
      "PathFollower",
      "PurePursuit",
      "SensingService",
      "Rng",
      "TopologyService",
      "BeliefMap",
      "PlanningService",
      "PlanningServiceAdapter",
      "BeliefVsTruth",
      "TraceBuffer",
      "SimAgent",
      "UgvState",
      "UavState",
      "BatteryState",
      "Pending",
      "Active",
      "ActionInfo",
      "AgentSensing",
      "SensorState",
    ];
    expect(required.filter((n) => !s.has(n))).toEqual([]);
  }, 120_000);

  it("gives every item a treatment, and the three kinds all occur", () => {
    const counts = { captured: 0, rebuilt: 0, scratch: 0 };
    for (const inv of Object.values(STATE_INVENTORY)) {
      for (const item of Object.values(inv)) {
        expect(["captured", "rebuilt", "scratch"]).toContain(item.treatment);
        counts[item.treatment]++;
      }
    }
    expect(counts.captured).toBeGreaterThan(0);
    expect(counts.rebuilt).toBeGreaterThan(0);
    expect(counts.scratch).toBeGreaterThan(0);
    for (const name of Object.keys(NOT_STATE)) expect(name in STATE_INVENTORY, `${name} is both state and not state`).toBe(false);
  });
});
