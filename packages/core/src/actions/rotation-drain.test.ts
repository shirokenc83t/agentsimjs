import { describe, expect, it } from "vitest";
import type { SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUgv } from "./testing/fakes.ts";

// ADR-0041: `UgvState.lastRotationRad` is reset at the start of every tick together with the step distance, so a rotation in place drains the battery
// only during the tick it happens in. (F3a M1 found and pinned the old behaviour: the value of the last rotation tick was read again every tick of a hold,
// and the battery kept draining its rotation energy for as long as the agent stood still.)

const DT = 0.1;
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

/** A differential UGV facing east with its target to the west: it rotates in place first. Then `hold` replaces the goTo. */
function rotateThenHold() {
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace: new CollectingTrace() }, DT);
  const a = makeUgv(50, 50, 0, { drive: "differential", turningRadiusM: 0, reverseAllowed: true });
  if (a.kind !== "ugv") throw new Error("ugv");
  rt.start(a, "goTo", { xM: 30, yM: 50 }, self(a), 0, 0);
  let t = 0;
  let rotated = 0;
  for (; t < 400; t++) {
    planner.advance(t);
    rt.tick(a, t, t * DT);
    if (a.state.lastRotationRad > 0) {
      rotated = a.state.lastRotationRad;
      break; // the vehicle is rotating in place
    }
  }
  expect(rotated, "the vehicle rotated in place").toBeGreaterThan(0);
  rt.start(a, "hold", {}, self(a), t + 1, (t + 1) * DT); // the goTo is replaced: from now nothing drives the vehicle
  return { rt, a, planner, t: t + 1, rotated };
}

describe("lastRotationRad after the vehicle stops driving (ADR-0041)", () => {
  it("is reset by the next tick, and the battery drains idle power only for every tick of a hold", () => {
    const { rt, a, planner, t, rotated } = rotateThenHold();
    if (a.kind !== "ugv") throw new Error("ugv");
    const { energy, battery } = a.body;
    const idle = (energy.idleW * DT) / 3600 / battery.capacityWh;
    for (let k = 0; k < 20; k++) {
      const before = a.battery.soc;
      planner.advance(t + k);
      rt.tick(a, t + k, (t + k) * DT);
      expect(a.state.speed).toBe(0);
      expect(a.state.lastStepM).toBe(0);
      expect(a.state.lastRotationRad, `tick ${t + k}`).toBe(0); // reset every tick: a hold does not rotate
      expect(before - a.battery.soc).toBeCloseTo(idle, 12); // idle power only
    }
    expect(rotated).toBeGreaterThan(0);
  });

  it("a rotation drains during the tick it happens in: footprint radius × angle on top of the idle power", () => {
    const spatial = new FakeSpatial();
    const planner = new FakePlanner(spatial);
    const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace: new CollectingTrace() }, DT);
    const a = makeUgv(50, 50, 0, { drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    if (a.kind !== "ugv") throw new Error("ugv");
    rt.start(a, "goTo", { xM: 30, yM: 50 }, self(a), 0, 0);
    const { footprintRadiusM: fp, energy, battery } = a.body;
    const idle = (energy.idleW * DT) / 3600 / battery.capacityWh;
    let checked = 0;
    for (let t = 0; t < 400 && checked < 3; t++) {
      const before = a.battery.soc;
      planner.advance(t);
      rt.tick(a, t, t * DT);
      if (a.state.lastRotationRad > 0 && a.state.lastStepM === 0) {
        checked++;
        expect(before - a.battery.soc).toBeCloseTo(idle + (energy.movingWhPerM * fp * a.state.lastRotationRad) / battery.capacityWh, 12);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
