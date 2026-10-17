import { hashBattery, type BatteryParams, type BatteryState, type EnergyParams } from "../body/battery.ts";
import { hashUav, hashUgv, type UavState, type UgvState } from "../body/kinematics.ts";
import type { FollowerParams } from "../body/follower.ts";
import type { StateHasher } from "../numerics/state-hash.ts";

/** UGV body parameters the runtime needs (resolved: every field present). */
export interface UgvBodyParams extends FollowerParams {
  readonly footprintRadiusM: number;
  readonly trackingMarginM: number;
  readonly battery: BatteryParams;
  readonly energy: EnergyParams;
}

export interface UavBodyParams {
  readonly maxSpeedMps: number;
  readonly climbRateMps: number;
  readonly cruiseAltitudeM: number;
  readonly clearanceM: number;
  readonly footprintRadiusM: number;
  readonly battery: BatteryParams;
  readonly energy: EnergyParams;
}

interface AgentCommon {
  readonly id: string;
  readonly key?: string;
  readonly base?: { readonly xM: number; readonly yM: number };
  readonly battery: BatteryState;
  /** Metres travelled since the current action started (odometry for results). */
  odometerM: number;
}

/** A physical agent's body and state. Mutated in place by the runtime (no allocation per tick). */
export type SimAgent =
  | (AgentCommon & { readonly kind: "ugv"; readonly body: UgvBodyParams; readonly state: UgvState })
  | (AgentCommon & { readonly kind: "uav"; readonly body: UavBodyParams; readonly state: UavState });

export function agentPosition(a: SimAgent): { xM: number; yM: number; zM: number } {
  return a.kind === "ugv" ? { xM: a.state.x, yM: a.state.y, zM: 0 } : { xM: a.state.x, yM: a.state.y, zM: a.state.z };
}

export function hashAgent(h: StateHasher, a: SimAgent): void {
  h.str(a.id);
  if (a.kind === "ugv") hashUgv(h, a.state);
  else hashUav(h, a.state);
  hashBattery(h, a.battery);
  h.f64(a.odometerM, "odometer");
}
