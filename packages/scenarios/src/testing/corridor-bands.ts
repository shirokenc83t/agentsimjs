import { describe, expect, it } from "vitest";
import { resolveBody } from "../body-defaults.ts";
import type { UgvBody } from "../schema.ts";
import { CORRIDOR_BANDS, corridorBandOutcomes } from "./corridors.ts";

/**
 * Registers the corridor property test for one drive model (ADR-0033), one test per width band. Split
 * per drive into separate files so they run in parallel. `minSucceeded[i]` is the band's lower bound on
 * arrivals out of 200 (measured counts in CHANGELOG.md, with a small margin).
 */
export function describeCorridorBands(drive: NonNullable<UgvBody["drive"]>, minSucceeded: readonly number[]): void {
  const body = resolveBody("ugv", { drive });
  describe(`${drive} UGV over seeded corridors (plan → pre-drive check → drive)`, () => {
    it.each(CORRIDOR_BANDS.map((b, i) => [b[0], b[1], minSucceeded[i] ?? 0] as const))(
      "corridors %s–%s m wide: arrive without contact, or fail having moved only by checked back-offs; at least %s arrive",
      (lo, hi, min) => {
        const { outcomes, succeeded } = corridorBandOutcomes(body, [lo, hi]);
        for (const o of outcomes) {
          // Reflex and planner don't fight: planned, pre-drive checked paths never need a reflex.
          expect(o.reflexes).toBe(0);
          // No contact, whether the vehicle arrived, drove a back-off, or neither.
          expect(o.minClearanceM).toBeGreaterThanOrEqual(body.footprintRadiusM);
          if (o.outcome !== "succeeded") {
            // A failure never follows a forward drive: only back-off reverses (ADR-0033 §4) may precede it.
            expect(o.rejectedBeforeMoving || o.movedOnlyBackingOff, o.outcome).toBe(true);
            expect(["kinematically_infeasible", "unreachable", "target_blocked"]).toContain(o.outcome);
          }
        }
        expect(succeeded).toBeGreaterThanOrEqual(min);
      },
    );
  });
}
