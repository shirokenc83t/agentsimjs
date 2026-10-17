import type { StateHasher } from "../numerics/state-hash.ts";

export interface BatteryParams {
  readonly capacityWh: number;
  readonly criticalSoc: number;
  /** Crossing it downwards raises `batteryLow` (ADR-0005 addition); above `criticalSoc`. Absent: no event. */
  readonly lowSoc?: number;
}

export interface EnergyParams {
  /** Energy per metre travelled. */
  readonly movingWhPerM: number;
  /** Power drawn while powered and not parked (UAV: hovering; UGV: electronics). */
  readonly idleW: number;
}

/** State of charge in [0, 1] (mutable, one per agent). */
export interface BatteryState {
  soc: number;
}

/**
 * Consumption proportional to motion and time (ROADMAP F1): `distanceM` travelled and `dtS` spent drawing
 * idle power (pass 0 for a parked, powered-down body). Returns the new state of charge, floored at 0.
 */
export function drainBattery(b: BatteryState, battery: BatteryParams, energy: EnergyParams, distanceM: number, dtS: number): number {
  const wh = energy.movingWhPerM * distanceM + (energy.idleW * dtS) / 3600;
  b.soc = Math.max(0, b.soc - wh / battery.capacityWh);
  return b.soc;
}

export function isBatteryCritical(b: BatteryState, battery: BatteryParams): boolean {
  return b.soc <= battery.criticalSoc;
}

export function hashBattery(h: StateHasher, b: BatteryState): void {
  h.f64(b.soc, "battery.soc");
}
