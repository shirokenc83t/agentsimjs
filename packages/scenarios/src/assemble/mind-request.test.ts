import { runLockstep, type Brain, type DecisionRequest, type SimAgent } from "@agentsim/core";
import { capabilityManifest } from "@agentsim/tools-schema";
import { describe, expect, it } from "vitest";
import { buildReferenceRun, type ReferenceRunOptions } from "../testing/reference-run.ts";
import { watchTruth } from "../testing/truth-watch.ts";

/** A brain that records every request it is asked and answers idle. */
class Capture implements Brain {
  readonly tier = "baseline" as const;
  readonly requests: DecisionRequest[] = [];
  constructor(readonly id = "capture") {}
  decide(req: DecisionRequest) {
    this.requests.push(req);
    return Promise.resolve({ decision: { kind: "idle" as const } });
  }
}

const UNKNOWN: ReferenceRunOptions["runConfig"] = { beliefs: { default: { init: "unknown" } } };
const agentOf = (run: ReturnType<typeof buildReferenceRun>, key: string): SimAgent => {
  const a = run.agents.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
};
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

/** Failure codes the availability predicate may answer. */
const AVAILABILITY_CODES = ["vehicle_unsupported", "scope_denied", "battery_depleted", "precondition_failed"];

/** Valid parameters per capability and vehicle kind (the parameter-dependent checks come later and may still refuse). */
const PARAMS = (name: string, kind: "ugv" | "uav"): unknown => {
  switch (name) {
    case "goTo":
      return kind === "ugv" ? { xM: 20, yM: 10 } : { xM: 20, yM: 12, altitudeM: 20 };
    case "takeoff":
      return { altitudeM: 10 };
    default:
      return {};
  }
};

describe("one availability predicate for allowedActions and the start check (ADR-0005 addition of 2026-10-11)", () => {
  type Knob = { airborne?: boolean; base?: boolean; empty?: boolean; rangeSensor?: boolean };
  const knobs: Knob[] = [];
  for (const airborne of [false, true]) for (const base of [true, false]) for (const empty of [false, true]) for (const rangeSensor of [true, false]) knobs.push({ airborne, base, empty, rangeSensor });

  const setup = (key: "rover" | "scout", k: Knob) => {
    const camera = { sensors: [{ id: "cam", type: "camera" }] };
    const run = buildReferenceRun({ scripts: {}, ...(k.rangeSensor === false ? { bodies: { [key]: camera } } : {}) });
    const a = agentOf(run, key);
    if (a.kind === "uav") {
      a.state.airborne = k.airborne ?? false;
      if (k.airborne) a.state.z = 20;
    }
    if (k.base === false) (a as { base?: unknown }).base = undefined;
    if (k.empty) a.battery.soc = 0;
    return { run, a };
  };

  it.each(["rover", "scout"] as const)("%s: over every state and capability, an action is allowed exactly when the start check does not refuse it for availability", (key) => {
    let checked = 0;
    for (const k of knobs) {
      const names = capabilityManifest().capabilities.filter((c) => c.kind === "action").map((c) => c.name);
      for (const name of names) {
        const { run, a } = setup(key, k);
        const menu = run.runtime.actionMenu(a);
        const listed = [...menu.allowed.map((x) => x.name), ...menu.unavailable.map((x) => x.name)].sort();
        expect(listed).toEqual([...names].sort()); // every capability is on exactly one list
        const r = run.runtime.start(a, name, PARAMS(name, a.kind), self(a), 0, 0);
        const u = menu.unavailable.find((x) => x.name === name);
        const label = `${key} ${JSON.stringify(k)} ${name}`;
        if (u) {
          expect(r.ok, label).toBe(false);
          expect(r.ok ? undefined : r.error.code, label).toBe(u.code);
          if (u.requires) expect(r.ok ? "" : r.error.message, label).toContain(u.requires);
        } else if (!r.ok) {
          expect(AVAILABILITY_CODES, label).not.toContain(r.error.code); // refused later, on parameters or the map
        }
        checked++;
      }
    }
    expect(checked).toBe(knobs.length * 6);
  });

  it("what a mind sees when an action is not allowed: it is absent from allowedActions and listed with the code and the precondition", () => {
    const { run, a } = setup("scout", { airborne: false });
    const menu = run.runtime.actionMenu(a);
    expect(menu.allowed.map((x) => x.name)).toEqual(["hold", "returnToBase", "takeoff"]);
    expect(menu.unavailable).toEqual([
      { name: "explore", code: "precondition_failed", requires: "airborne" },
      { name: "goTo", code: "precondition_failed", requires: "airborne" },
      { name: "land", code: "precondition_failed", requires: "airborne" },
    ]);
  });
});

describe("the decision request (ADR-0005 addition of 2026-10-11)", () => {
  it("carries beliefs, space, allowedActions with manifest schemas, and unavailable; keys in a fixed order", async () => {
    const mind = new Capture();
    const run = buildReferenceRun({
      runConfig: UNKNOWN,
      scripts: {},
      brains: { rover: mind },
      objects: [{ id: "marker-1", kind: "marker", position: { xM: 14, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } }],
    });
    await runLockstep(run.world, run.scheduler, 60);
    const req = mind.requests.at(-1) as DecisionRequest;
    expect(Object.keys(req)).toEqual(["agentId", "tick", "simTimeS", "events", "eventsDropped", "self", "beliefs", "space", "allowedActions", "unavailable"]);
    expect(Object.keys(req.self)).toEqual(["kind", "xM", "yM", "headingRad", "soc", "running", "timers"]);
    // Entity beliefs: the marker, with id and kind (F2 idealization), nothing else.
    expect(req.beliefs.entities).toEqual([expect.objectContaining({ id: "marker-1", kind: "marker", state: "detected" })]);
    expect(req.beliefs.map.knownPct).toBeGreaterThan(0);
    // Space: the ADR-0039 summary of its own map, with frontiers once it has looked around.
    expect(req.space.region).toMatch(/^r-\d+-\d+$/);
    expect(req.space.frontiers.length).toBeGreaterThan(0);
    // The menu: schemas are the manifest's, by name.
    const manifest = new Map(capabilityManifest().capabilities.map((c) => [c.name, c.params]));
    expect(req.allowedActions.length).toBeGreaterThan(0);
    for (const x of req.allowedActions) expect(x.paramsSchema).toEqual(manifest.get(x.name));
    expect(req.allowedActions.map((x) => x.name)).toEqual([...req.allowedActions.map((x) => x.name)].sort());
    expect(req.unavailable.map((x) => x.name)).toContain("takeoff"); // a ground vehicle cannot take off
    expect(req.unavailable.find((x) => x.name === "takeoff")).toEqual({ name: "takeoff", code: "vehicle_unsupported" });
  });

  it("is built from the agent's own beliefs: for a belief agent it reads no ground-truth cell content", async () => {
    const mind = new Capture();
    const run = buildReferenceRun({ runConfig: UNKNOWN, scripts: {}, brains: { rover: mind } });
    await runLockstep(run.world, run.scheduler, 30); // sensing runs unwatched
    const truth = watchTruth(run.spatial);
    const rover = agentOf(run, "rover");
    const view = truth.during(() => {
      const v = run.mindView.view(rover.id, 3);
      const menu = run.runtime.actionMenu(rover);
      return { v, menu };
    });
    expect(truth.hits).toEqual([]);
    expect(view.v.space.regions.length).toBeGreaterThan(0);
  });

  it("positive control: the same measurement sees ground-truth reads for an ideal agent (the instrument works)", async () => {
    const run = buildReferenceRun({ scripts: {} });
    await runLockstep(run.world, run.scheduler, 5);
    const truth = watchTruth(run.spatial);
    truth.during(() => run.mindView.view(agentOf(run, "rover").id, 1));
    expect(truth.hits.length).toBeGreaterThan(0);
  });

  it("an ideal agent's request is built on the ground truth it is labelled to have: no frontiers, every region known", async () => {
    const mind = new Capture();
    const run = buildReferenceRun({ scripts: {}, brains: { rover: mind } });
    await runLockstep(run.world, run.scheduler, 5);
    const req = mind.requests[0] as DecisionRequest;
    expect(req.space.frontiers).toEqual([]);
    expect(req.beliefs.map.knownPct).toBe(100);
  });

  it("entity beliefs are nearest first (ties by ID), at most 16, with the rest counted", async () => {
    const mind = new Capture();
    const objects = Array.from({ length: 20 }, (_, k) => ({ id: `obj-${String(k).padStart(2, "0")}`, kind: "marker", position: { xM: 11 + (k % 5) * 0.5, yM: 8 + Math.floor(k / 5) * 0.8 }, size: { radiusM: 0.1, heightM: 1 } }));
    const run = buildReferenceRun({ runConfig: UNKNOWN, scripts: {}, brains: { rover: mind }, objects });
    await runLockstep(run.world, run.scheduler, 40);
    const rover = agentOf(run, "rover");
    const b = run.mindView.view(rover.id, 4).beliefs;
    expect(b.entities.length).toBeLessThanOrEqual(16);
    expect(b.entities.length + b.entitiesOmitted).toBeGreaterThanOrEqual(b.entities.length);
    const d = (e: { xM: number; yM: number }) => (e.xM - rover.state.x) ** 2 + (e.yM - rover.state.y) ** 2;
    for (let k = 1; k < b.entities.length; k++) expect(d(b.entities[k] as never)).toBeGreaterThanOrEqual(d(b.entities[k - 1] as never) - 0.02);
  });
});
