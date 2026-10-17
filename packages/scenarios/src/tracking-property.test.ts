import { Rng } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { resolveBody } from "./body-defaults.ts";
import { estimatedTrackingCutM } from "./body-warnings.ts";
import { generateCorridor, planAndTrack } from "./testing/corridors.ts";

/**
 * Seeded property test of the forward-only pure-pursuit cut (F1 d4 follow-up): plan with footprint +
 * margin inflation, track over 200 generated corridors with corners and hairpins up to 170°.
 * - The footprint never touches an obstacle.
 * - The inward cross-track error (clearance lost relative to the path) stays below the tracking margin.
 *   The unsigned error is larger at corners sharper than the turning radius, where the vehicle must swing
 *   wide; that swing moves away from the obstacle the path hugs, so it is reported, not asserted.
 * Per-drive runs through the real runtime are in corridor-bands.*.test.ts.
 */
const CASES = 200;
const corridors = Array.from({ length: CASES }, (_, k) => generateCorridor(Rng.fromSeed(2026).derive(`corridor/${k}`)));
const forwardOnly = resolveBody("ugv", { drive: "forward-only" });

describe("forward-only plan → pure pursuit over generated corridors", () => {
  it("no contact, inward error below the margin, every case arrives", () => {
    const b = forwardOnly;
    const outcomes = corridors.map((c) => planAndTrack(c, b));
    expect(outcomes.every((o) => o.planned)).toBe(true);
    expect(outcomes.filter((o) => !o.arrived).length).toBe(0);
    const minClearance = Math.min(...outcomes.map((o) => o.minClearanceM));
    const maxInward = Math.max(...outcomes.map((o) => o.maxInwardM));
    expect(minClearance).toBeGreaterThanOrEqual(b.footprintRadiusM);
    expect(maxInward).toBeLessThan(b.trackingMarginM);
    expect(maxInward).toBeLessThanOrEqual(estimatedTrackingCutM(b.lookaheadM));
  });

  it.each([
    [1.5, 1.125],
    [1.5, 1.5],
    [2.5, 2.0],
  ])("the cut estimate is conservative (turning radius %s m, look-ahead %s m)", (turningRadiusM, lookaheadM) => {
    const wide = Array.from({ length: 60 }, (_, k) => generateCorridor(Rng.fromSeed(7).derive(`wide/${k}`), [2 * turningRadiusM + 2.5, 2 * turningRadiusM + 4.5]));
    const body = { ...forwardOnly, turningRadiusM, lookaheadM, trackingMarginM: 0.6 };
    const maxInward = Math.max(...wide.map((c) => planAndTrack(c, body).maxInwardM));
    expect(maxInward).toBeLessThanOrEqual(estimatedTrackingCutM(lookaheadM));
  });
});
