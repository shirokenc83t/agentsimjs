import type { VehicleTraversal } from "@agentsim/algorithms";
import type { ResolvedUavBody, ResolvedUgvBody } from "./body-defaults.ts";
import type { EffectiveAgentConfig } from "./run-config/resolve.ts";

/**
 * The planner's view of an agent's body, from its effective configuration. The inflation radius
 * (UGV: footprint + tracking margin; UAV: footprint) comes from the same resolved values that
 * `effectiveConfigHash` covers, and is part of the planning view's cache key.
 */
export function traversalFor(agent: EffectiveAgentConfig, cruiseAltitudeM?: number): VehicleTraversal {
  if (agent.kind === "ugv") {
    const b = agent.body as ResolvedUgvBody;
    return {
      vehicle: "ugv",
      cruiseAltitudeM: 0,
      clearanceM: 0,
      speedMps: b.maxSpeedMps,
      energyWhPerM: b.energy.movingWhPerM,
      inflationRadiusM: b.footprintRadiusM + b.trackingMarginM,
    };
  }
  const b = agent.body as ResolvedUavBody;
  return {
    vehicle: "uav",
    cruiseAltitudeM: cruiseAltitudeM ?? b.cruiseAltitudeM,
    clearanceM: b.clearanceM,
    speedMps: b.maxSpeedMps,
    energyWhPerM: b.energy.movingWhPerM,
    inflationRadiusM: b.footprintRadiusM,
  };
}
