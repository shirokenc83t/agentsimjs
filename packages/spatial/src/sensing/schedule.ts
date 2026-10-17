import { utf8, xxHash32 } from "@agentsim/core";

/**
 * Sensor scheduling on sim time (ADR-0012 addition of 2026-10-09), in integer microseconds so that every
 * engine reads at the same ticks.
 */

/** A sensor's period (µs) from its rate. */
export function periodUs(rateHz: number): number {
  return Math.round(1_000_000 / rateHz);
}

/**
 * A sensor's phase in [0, period): the project's xxHash32 of a stable name (`<agent key>/<sensor id>`, or the
 * agent ID without a key), never a platform hash and never load order.
 */
export function sensorPhaseUs(name: string, periodUsValue: number): number {
  return xxHash32(utf8(name)) % periodUsValue;
}

/**
 * Whether a sensor reads in the tick covering (prevUs, nowUs]: when ⌊(t + φ) / P⌋ increases. With a period no
 * shorter than the tick (validated: `sensor_rate_above_tick_rate`), this is at most once per tick.
 */
export function readsAtTick(nowUs: number, prevUs: number, periodUsValue: number, phaseUs: number): boolean {
  return Math.floor((nowUs + phaseUs) / periodUsValue) > Math.floor((prevUs + phaseUs) / periodUsValue);
}
