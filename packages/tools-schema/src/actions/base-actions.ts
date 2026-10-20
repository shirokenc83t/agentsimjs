import Type from "typebox";
import type { CapabilityDef } from "../capability.ts";

// Coarse schema bounds keep values finite and sane; the runtime checks the actual map and body limits
// (target_out_of_bounds, altitude_out_of_range).
const COORD_LIMIT_M = 1_000_000;
const ALTITUDE_LIMIT_M = 10_000;
const MAX_HOLD_S = 86_400;

const coord = (description: string) => Type.Number({ minimum: -COORD_LIMIT_M, maximum: COORD_LIMIT_M, description });
const altitude = (description: string) => Type.Number({ minimum: 0, maximum: ALTITUDE_LIMIT_M, description });

const Position = Type.Object(
  {
    xM: coord("Metres east of the map origin (south-west corner)."),
    yM: coord("Metres north of the map origin."),
    zM: altitude("Altitude in metres above the ground datum (0 for ground vehicles)."),
  },
  { additionalProperties: false },
);

const FRAME =
  "Coordinates are in the world frame: x metres east and y metres north of the map origin (the south-west corner).";

/** Shared failure guide of goTo and returnToBase: three distinct reasons a target cannot be reached. */
const TARGET_FAILURES =
  "target_blocked: the target itself cannot hold this vehicle (an obstacle, a no-fly volume at that altitude, or too close to an obstacle for the vehicle's footprint). " +
  "unreachable: the target is free but no path to it exists. " +
  "kinematically_infeasible: a path exists but this ground vehicle cannot follow it (it only drives forwards and has a minimum turning radius, e.g. there is no room to turn around). " +
  "planning_budget: planning ran out of its budget before finding a path.";

export const goTo = {
  name: "goTo",
  kind: "action",
  description:
    `Move to a target point. The vehicle plans a path around known obstacles with its configured planner and cost profile, then follows it. ${FRAME} ` +
    "While the path is being computed the action is running in its planning phase; planning takes simulated time proportional to the search effort. " +
    "A UAV must be airborne; altitudeM sets its cruise altitude (default: its current altitude). Ground vehicles must omit altitudeM. " +
    `Failures: ${TARGET_FAILURES}`,
  params: Type.Object(
    {
      xM: coord("Target x, metres east of the map origin."),
      yM: coord("Target y, metres north of the map origin."),
      altitudeM: Type.Optional(altitude("UAV only: cruise altitude in metres above the ground datum.")),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      position: Position,
      pathLengthM: Type.Number({ minimum: 0, description: "Length of the path actually travelled, metres." }),
    },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [{ name: "airborne", vehicles: ["uav"] }],
  failureCodes: ["target_out_of_bounds", "target_blocked", "altitude_out_of_range", "unreachable", "planning_budget", "kinematically_infeasible", "geofence"],
} as const satisfies CapabilityDef;

export const explore = {
  name: "explore",
  kind: "action",
  description:
    "Explore unknown space on this agent's own map, in iterations: the frontiers (known free space next to unknown space) within radiusM of the agent first, then it travels to the nearest one left and starts the next iteration, until none is left in scope. Needs a range sensor (lidar or proximity); a UAV must be airborne and explores at its current altitude. " +
    "region: a region ID from the space summary (e.g. r-03-05); omitted = the whole map. It limits which frontiers are targets, not the path. " +
    "strategy: nearest (default) = nearest in a straight line; largest = most cells. " +
    "radiusM: iteration radius in metres; omitted = the agent's configured radius. Searches are bounded to a window around the iteration, so an unreachable frontier costs the window, not the map: it is set aside for the iteration, retried from another centre with larger windows, and marked unreachable (until its map changes) after three centres. " +
    "Succeeds with region_explored or frontier_exhausted (no reachable frontier left). " +
    "Failures: unknown_region; no_map_data (no data at its own position after 2 s); geofence (a UAV would leave a geofence or its altitude limits).",
  params: Type.Object(
    {
      region: Type.Optional(Type.String({ pattern: "^r-[0-9]{2,4}-[0-9]{2,4}$", description: "Region ID (r-<column>-<row>) to explore; omit for the whole map." })),
      strategy: Type.Optional(Type.Union([Type.Literal("nearest"), Type.Literal("largest")], { description: "Target choice: nearest (straight-line distance, default) or largest (most frontier cells)." })),
      radiusM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100_000, description: "Radius of an exploration iteration in metres; omit for the agent's configured radius." })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      reason: Type.Union([Type.Literal("region_explored"), Type.Literal("frontier_exhausted")], { description: "Why exploration ended." }),
      groupsVisited: Type.Integer({ minimum: 0, description: "Frontier targets reached or resolved by sensing on the way." }),
      groupsMarked: Type.Integer({ minimum: 0, description: "Frontier groups this action found unreachable." }),
      distanceM: Type.Number({ minimum: 0, description: "Distance travelled, metres." }),
      position: Position,
    },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [{ name: "airborne", vehicles: ["uav"] }, { name: "hasRangeSensor" }],
  failureCodes: ["unknown_region", "no_map_data", "geofence"],
} as const satisfies CapabilityDef;

export const hold = {
  name: "hold",
  kind: "action",
  description:
    "Stop and stay at the current position (a UAV hovers at its current altitude). " +
    "With durationS the action succeeds after that many simulated seconds; without it, it runs until another action replaces it.",
  params: Type.Object(
    {
      durationS: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_HOLD_S, description: "Simulated seconds to hold." })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { heldS: Type.Number({ minimum: 0, description: "Simulated seconds held." }) },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: [],
} as const satisfies CapabilityDef;

export const returnToBase = {
  name: "returnToBase",
  kind: "action",
  description:
    "Plan a path to this agent's base and follow it; a UAV flies at its cruise altitude and lands on arrival. " +
    `Requires a base. Failures (the base is the target): ${TARGET_FAILURES} landing_blocked: a UAV cannot land at the base.`,
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object(
    {
      position: Position,
      landed: Type.Boolean({ description: "True for a UAV that landed at the base." }),
    },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [{ name: "hasBase" }],
  failureCodes: ["target_blocked", "unreachable", "planning_budget", "kinematically_infeasible", "landing_blocked", "geofence"],
} as const satisfies CapabilityDef;

export const takeoff = {
  name: "takeoff",
  kind: "action",
  description:
    "UAV only: climb vertically from the ground to altitudeM (metres above the ground datum). " +
    "Fails if the altitude is outside the airspace limits of the map.",
  params: Type.Object(
    { altitudeM: Type.Number({ exclusiveMinimum: 0, maximum: ALTITUDE_LIMIT_M, description: "Target altitude, metres above the ground datum." }) },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { altitudeM: Type.Number({ minimum: 0, description: "Altitude reached, metres." }) },
    { additionalProperties: false },
  ),
  vehicles: ["uav"],
  scope: "self",
  preconditions: [{ name: "grounded" }],
  failureCodes: ["altitude_out_of_range"],
} as const satisfies CapabilityDef;

export const land = {
  name: "land",
  kind: "action",
  description: "UAV only: descend vertically and land at the current position. Fails if the ground below is occupied.",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({ position: Position }, { additionalProperties: false }),
  vehicles: ["uav"],
  scope: "self",
  preconditions: [{ name: "airborne" }],
  failureCodes: ["landing_blocked"],
} as const satisfies CapabilityDef;
