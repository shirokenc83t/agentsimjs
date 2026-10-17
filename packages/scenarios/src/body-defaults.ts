import { ackermannRadiusM, type DriveKind } from "@agentsim/core";
import type { SensorSpec, UavBody, UgvBody } from "./schema.ts";

/** A resolved range sensor (lidar or IR/proximity; ADR-0012 addition of 2026-10-09). */
export interface ResolvedRangeSensor {
  readonly id: string;
  readonly type: "lidar" | "proximity";
  readonly rateHz: number;
  readonly rangeM: number;
  readonly dropoutProbability: number;
  readonly rays: number;
  readonly fovDeg: number;
  /** UGV: sensor height above the ground (UAV range sensors sit at the vehicle's altitude: 0). */
  readonly mountHeightM: number;
  readonly beamHalfHeightM: number;
  readonly rangeSigmaM: number;
  readonly logOddsHit: number;
  readonly logOddsMiss: number;
}

export interface ResolvedCamera {
  readonly id: string;
  readonly type: "camera";
  readonly rateHz: number;
  readonly rangeM: number;
  readonly dropoutProbability: number;
  readonly fovDeg: number;
  /** UGV: height above the ground; UAV: height above the vehicle (ADR-0025 addition of 2026-10-09). */
  readonly mountHeightM: number;
  readonly pDetect: number;
  readonly positionSigmaM: number;
}

export type ResolvedSensor = ResolvedRangeSensor | ResolvedCamera;

interface ResolvedBattery {
  readonly capacityWh: number;
  readonly initialSoc: number;
  readonly criticalSoc: number;
  /** Crossing it downwards raises `batteryLow` (ADR-0005 addition); above `criticalSoc`. */
  readonly lowSoc: number;
}

/** Fully resolved body parameters (every field present). Used by kinematics, battery, planning and sensing. */
export interface ResolvedUavBody {
  readonly maxSpeedMps: number;
  readonly climbRateMps: number;
  readonly cruiseAltitudeM: number;
  readonly clearanceM: number;
  readonly footprintRadiusM: number;
  readonly battery: ResolvedBattery;
  readonly energy: { readonly movingWhPerM: number; readonly idleW: number };
  readonly onboardComputeExpansionsPerTick: number;
  readonly sensors: readonly ResolvedSensor[];
  readonly beliefs: { readonly lostAfterS: number };
}

export interface ResolvedUgvBody {
  /** Drive model and its parameters (ADR-0033). */
  readonly drive: DriveKind;
  readonly reverseAllowed: boolean;
  readonly maxReverseSpeedMps: number;
  readonly maxYawRateRadps: number;
  readonly wheelbaseM: number;
  readonly maxSteeringAngleRad: number;
  readonly maxSteeringRateRadps: number;
  readonly maxSpeedMps: number;
  /** Effective minimum turning radius: the authored value for forward-only, derived for the other drives. */
  readonly turningRadiusM: number;
  readonly footprintRadiusM: number;
  readonly trackingMarginM: number;
  readonly arrivalToleranceM: number;
  readonly lookaheadM: number;
  readonly battery: ResolvedBattery;
  readonly energy: { readonly movingWhPerM: number; readonly idleW: number };
  readonly onboardComputeExpansionsPerTick: number;
  readonly sensors: readonly ResolvedSensor[];
  readonly beliefs: { readonly lostAfterS: number };
}

/**
 * Sensor defaults per vehicle kind and sensor type (ADR-0025 addition of 2026-10-09). A body without `sensors`
 * gets one of each, with ids `lidar`, `proximity`, `camera`; an authored sensor is completed from its type's
 * defaults. A UAV range sensor without `beamHalfHeightM` uses the body's clearance (`clearance` here).
 */
const CLEARANCE = -1;
type SensorDefaults = { readonly lidar: ResolvedRangeSensor; readonly proximity: ResolvedRangeSensor; readonly camera: ResolvedCamera };
const RANGE_COMMON = { dropoutProbability: 0, logOddsHit: 30, logOddsMiss: 20 } as const;
const CAMERA_COMMON = { type: "camera", id: "camera", rateHz: 5, fovDeg: 90, pDetect: 1, positionSigmaM: 0, dropoutProbability: 0 } as const;
export const BUILTIN_SENSOR_DEFAULTS: { readonly uav: SensorDefaults; readonly ugv: SensorDefaults } = {
  ugv: {
    lidar: { ...RANGE_COMMON, id: "lidar", type: "lidar", rateHz: 10, rangeM: 30, rays: 180, fovDeg: 360, mountHeightM: 0.5, beamHalfHeightM: 0.5, rangeSigmaM: 0.02 },
    // 10 Hz, the run's tick rate: faster sensors are rejected (ADR-0012 addition; ADR-0025 correction).
    proximity: { ...RANGE_COMMON, id: "proximity", type: "proximity", rateHz: 10, rangeM: 2, rays: 8, fovDeg: 360, mountHeightM: 0.3, beamHalfHeightM: 0.3, rangeSigmaM: 0.01 },
    camera: { ...CAMERA_COMMON, rangeM: 40, mountHeightM: 1 },
  },
  uav: {
    lidar: { ...RANGE_COMMON, id: "lidar", type: "lidar", rateHz: 10, rangeM: 50, rays: 180, fovDeg: 360, mountHeightM: 0, beamHalfHeightM: CLEARANCE, rangeSigmaM: 0.02 },
    proximity: { ...RANGE_COMMON, id: "proximity", type: "proximity", rateHz: 10, rangeM: 3, rays: 8, fovDeg: 360, mountHeightM: 0, beamHalfHeightM: CLEARANCE, rangeSigmaM: 0.01 },
    camera: { ...CAMERA_COMMON, rangeM: 60, mountHeightM: 0 },
  },
};

function resolveSensors(kind: "uav" | "ugv", authored: readonly SensorSpec[] | undefined, clearanceM: number): ResolvedSensor[] {
  const d = BUILTIN_SENSOR_DEFAULTS[kind];
  const specs: readonly SensorSpec[] = authored ?? [{ id: "lidar", type: "lidar" }, { id: "proximity", type: "proximity" }, { id: "camera", type: "camera" }];
  return specs.map((s): ResolvedSensor => {
    if (s.type === "camera") return { ...d.camera, ...s };
    const r: ResolvedRangeSensor = { ...d[s.type], ...s };
    return r.beamHalfHeightM === CLEARANCE ? { ...r, beamHalfHeightM: clearanceM } : r;
  });
}

export interface BodyDefaults {
  readonly uav: Omit<ResolvedUavBody, "sensors">;
  readonly ugv: Omit<ResolvedUgvBody, "sensors">;
}

/**
 * Built-in body defaults, the first precedence level (ADR-0028). Changing a value here changes
 * `effectiveConfigHash` of runs that rely on it, which is how such changes are detected across versions.
 */
export const BUILTIN_BODY_DEFAULTS: BodyDefaults = {
  uav: {
    maxSpeedMps: 8,
    climbRateMps: 2,
    cruiseAltitudeM: 20,
    clearanceM: 2,
    footprintRadiusM: 0.4,
    battery: { capacityWh: 100, initialSoc: 1, criticalSoc: 0.2, lowSoc: 0.3 },
    energy: { movingWhPerM: 0.02, idleW: 150 },
    onboardComputeExpansionsPerTick: 20_000,
    beliefs: { lostAfterS: 2 },
  },
  ugv: {
    drive: "differential",
    reverseAllowed: true,
    maxReverseSpeedMps: 0.5,
    maxYawRateRadps: 1.5,
    wheelbaseM: 1,
    maxSteeringAngleRad: 0.6,
    maxSteeringRateRadps: 1,
    maxSpeedMps: 2,
    // Used by forward-only bodies; differential is 0 and Ackermann derives its radius (≈1.46 m by default).
    turningRadiusM: 1.5,
    footprintRadiusM: 0.5,
    trackingMarginM: 0.25,
    arrivalToleranceM: 0.5,
    // Look-ahead 0.8 × turning radius: over 200 seeded corridors pure pursuit cuts corners inwards by at
    // most ~0.21 m, within the 0.25 m tracking margin (1.5 m: 0.27 m; 2 m: 0.38 m and wall contact).
    // See tracking-property.test.ts and estimatedTrackingCutM.
    lookaheadM: 1.2,
    battery: { capacityWh: 500, initialSoc: 1, criticalSoc: 0.15, lowSoc: 0.3 },
    energy: { movingWhPerM: 0.05, idleW: 10 },
    onboardComputeExpansionsPerTick: 20_000,
    beliefs: { lostAfterS: 2 },
  },
};

/** Drive parameters a run configuration may override (ADR-0033, the run config's `drive` section). */
export type DriveOverride = Partial<Pick<ResolvedUgvBody, "drive" | "reverseAllowed" | "maxReverseSpeedMps" | "maxYawRateRadps" | "wheelbaseM" | "maxSteeringAngleRad" | "maxSteeringRateRadps">>;

/**
 * Scenario body over built-ins, field by field (nested battery and energy too), then a UGV's run-config
 * drive overrides. A UGV's effective turning radius and reverse ability follow from its drive model.
 */
export function resolveBody(kind: "uav", body: UavBody, defaults?: BodyDefaults): ResolvedUavBody;
export function resolveBody(kind: "ugv", body: UgvBody, defaults?: BodyDefaults, drive?: DriveOverride): ResolvedUgvBody;
export function resolveBody(
  kind: "uav" | "ugv",
  body: UavBody | UgvBody,
  defaults: BodyDefaults = BUILTIN_BODY_DEFAULTS,
  drive: DriveOverride = {},
): ResolvedUavBody | ResolvedUgvBody {
  const base = defaults[kind];
  const { battery, energy, sensors, beliefs, ...rest } = body;
  const merged = { ...base, ...rest, battery: { ...base.battery, ...battery }, energy: { ...base.energy, ...energy }, beliefs: { ...base.beliefs, ...beliefs } };
  const clearanceM = kind === "uav" ? (merged as Omit<ResolvedUavBody, "sensors">).clearanceM : 0;
  const withSensors = { ...merged, sensors: resolveSensors(kind, sensors, clearanceM) };
  if (kind === "uav") return withSensors as ResolvedUavBody;
  const u = { ...(withSensors as ResolvedUgvBody), ...drive };
  const turningRadiusM = u.drive === "differential" ? 0 : u.drive === "ackermann" ? ackermannRadiusM(u.wheelbaseM, u.maxSteeringAngleRad) : u.turningRadiusM;
  return { ...u, turningRadiusM, reverseAllowed: u.drive === "forward-only" ? false : u.reverseAllowed };
}
