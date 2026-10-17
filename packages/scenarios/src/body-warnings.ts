import type { ResolvedUgvBody } from "./body-defaults.ts";

/**
 * Body consistency warnings: valid documents that are likely to misbehave. They never block loading; they
 * are shown in the editor and recorded with the run so a researcher can see why a vehicle scraped a wall.
 */
export type BodyWarningCode = "lookahead_exceeds_turning_radius" | "tracking_margin_below_estimated_cut";

export interface BodyWarning {
  readonly code: BodyWarningCode;
  readonly message: string;
  readonly path: string;
}

/**
 * Estimated worst-case inward corner cut of the pure-pursuit follower for a look-ahead (metres). Empirical:
 * measured over seeded corridors with corners and hairpins (tracking-property.test.ts asserts it is
 * conservative), for look-ahead between ~0.75 and 1 × the turning radius.
 */
export function estimatedTrackingCutM(lookaheadM: number): number {
  return 0.19 * lookaheadM;
}

/** Warnings for one resolved UGV body (`path` points at the agent's body in the scenario). */
export function ugvBodyWarnings(b: ResolvedUgvBody, path: string): BodyWarning[] {
  const out: BodyWarning[] = [];
  // Only drives with a minimum turning radius cut corners by turning too wide (differential rotates in place).
  if (b.drive !== "differential" && b.lookaheadM > b.turningRadiusM) {
    out.push({
      code: "lookahead_exceeds_turning_radius",
      message: `look-ahead ${b.lookaheadM} m exceeds the turning radius ${b.turningRadiusM} m: corners are cut more (suggested ≤ ${(0.8 * b.turningRadiusM).toFixed(2)} m)`,
      path: `${path}/lookaheadM`,
    });
  }
  const cut = estimatedTrackingCutM(b.lookaheadM);
  if (b.trackingMarginM < cut) {
    out.push({
      code: "tracking_margin_below_estimated_cut",
      message: `tracking margin ${b.trackingMarginM} m is below the follower's estimated worst-case cut ${cut.toFixed(2)} m for a ${b.lookaheadM} m look-ahead`,
      path: `${path}/trackingMarginM`,
    });
  }
  return out;
}
