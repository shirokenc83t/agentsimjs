import { describe, expect, it } from "vitest";
import type { SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakePlanner, FakeSpatial, makeUgv } from "./testing/fakes.ts";

// F3a M1, T-004 FINDING, pinned (not fixed): `UgvState.lastRotationRad` is set by `stepDrive` when a differential drive
// rotates in place, and reset only by the next `stepDrive` call. When the vehicle stops driving (the action ends, or is
// replaced by a hold) nothing resets it, so the value of the last rotation tick is read again every tick: the battery
// keeps draining `movingWhPerM × footprintRadiusM × lastRotationRad` of energy per tick for as long as the agent stands
// still, and `lastRotationRad` stays in the state hash.
//
// The expected behaviour (a vehicle that is not rotating draws no rotation energy) would change battery levels, state
// hashes and the goldens, so it needs a decision (ADR-0002: a recorded hash changes only by a decision). This test
// documents today's behaviour so that a change of it is noticed and decided, and that a snapshot captures the field.

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
  for (; t < 400; t++) {
    planner.advance(t);
    rt.tick(a, t, t * DT);
    if (a.state.lastRotationRad > 0) break; // the vehicle is rotating in place
  }
  expect(a.kind === "ugv" && a.state.lastRotationRad > 0, "the vehicle rotated in place").toBe(true);
  rt.start(a, "hold", {}, self(a), t + 1, (t + 1) * DT); // the goTo is replaced: from now nothing drives the vehicle
  return { rt, a, planner, t: t + 1 };
}

describe("lastRotationRad after the vehicle stops driving (T-004 finding, pinned)", () => {
  it("is never reset, and the battery keeps draining its rotation energy every tick of a hold", () => {
    const { rt, a, planner, t } = rotateThenHold();
    if (a.kind !== "ugv") throw new Error("ugv");
    const stuck = a.state.lastRotationRad;
    expect(stuck).toBeGreaterThan(0);
    const per = (soc0: number, soc1: number) => soc0 - soc1;
    const { footprintRadiusM: fp, energy, battery } = a.body;
    const idle = (energy.idleW * DT) / 3600 / battery.capacityWh;
    const rotation = (energy.movingWhPerM * fp * stuck) / battery.capacityWh;
    for (let k = 0; k < 20; k++) {
      const before = a.battery.soc;
      planner.advance(t + k);
      rt.tick(a, t + k, (t + k) * DT);
      expect(a.state.speed).toBe(0);
      expect(a.state.lastStepM).toBe(0);
      expect(a.state.lastRotationRad, `tick ${t + k}`).toBe(stuck); // not reset by a hold
      expect(per(before, a.battery.soc)).toBeCloseTo(idle + rotation, 12); // idle power plus rotation energy, every tick
    }
    expect(rotation).toBeGreaterThan(0);
  });

  it("a vehicle whose last rotation was reset by hand drains idle power only: the difference is the whole of the finding", () => {
    const stuckRun = rotateThenHold();
    const cleanRun = rotateThenHold();
    if (stuckRun.a.kind !== "ugv" || cleanRun.a.kind !== "ugv") throw new Error("ugv");
    cleanRun.a.state.lastRotationRad = 0;
    for (let k = 0; k < 20; k++) {
      for (const r of [stuckRun, cleanRun]) {
        r.planner.advance(r.t + k);
        r.rt.tick(r.a, r.t + k, (r.t + k) * DT);
      }
    }
    expect(stuckRun.a.battery.soc).toBeLessThan(cleanRun.a.battery.soc);
  });
});
