import Type from "typebox";
import type { CapabilityDef } from "../capability.ts";

/** The most waypoints `planPath` returns (the path is simplified to fit), the most legs `estimateCost` takes, the most alternatives `kShortestPaths` returns (ADR-0014 addition of 2026-10-29). */
export const COMPUTE_LIMITS = { maxWaypoints: 32, maxRoutePoints: 10, maxAlternatives: 3 } as const;

/** Whether a compute call found what it was asked for, with the planner's own words: `budget_exceeded` is the node budget of the agent's planner. */
export const COMPUTE_STATUSES = ["found", "not_found", "budget_exceeded"] as const;
const Status = Type.Union(COMPUTE_STATUSES.map((s) => Type.Literal(s)), { description: "found, not_found (no route on your own map) or budget_exceeded (the search ran out of its node budget)." });

const Point = Type.Union(
  [
    Type.Object(
      {
        xM: Type.Number({ description: "East, metres, in the world frame." }),
        yM: Type.Number({ description: "North, metres, in the world frame." }),
        zM: Type.Optional(Type.Number({ description: "Height in metres; ignored (a UAV plans at its cruise altitude)." })),
      },
      { additionalProperties: false },
    ),
    Type.Literal("home", { description: "Your base." }),
  ],
  { description: "A point in metres, or the word home for your base." },
);

const Figures = {
  lengthM: Type.Number({ description: "Length of the route in metres." }),
  etaS: Type.Number({ description: "Time to drive it at your speed, in seconds." }),
  energyPct: Type.Number({ description: "Share of a full battery it takes, in percent." }),
};

/**
 * The compute tools (ADR-0014 addition of 2026-10-29): a mind asks for them while it decides, and they answer from its own map and planner, never from the ground truth. They change nothing in the world or in
 * the agent, start no action and have no scope of their own: the cap on calls per decision belongs to the mind's profile.
 */
export const planPath = {
  name: "planPath",
  kind: "compute",
  description:
    "Plan a route on your own map with your own planner and ask what it would cost, without moving. Use it to compare destinations before you choose one. " +
    "from defaults to where you are. It returns status, lengthM, etaS and energyPct of the route and at most 32 simplified waypoints; the route avoids what you believe is blocked and prefers what you know. " +
    "Failures: point_out_of_bounds, no_home (you have no base).",
  params: Type.Object({ to: Point, from: Type.Optional(Point) }, { additionalProperties: false }),
  result: Type.Object(
    {
      status: Status,
      ...Figures,
      expansions: Type.Integer({ description: "Nodes the search expanded." }),
      waypoints: Type.Array(Type.Object({ xM: Type.Number(), yM: Type.Number() }, { additionalProperties: false }), { maxItems: COMPUTE_LIMITS.maxWaypoints, description: "The route's turning points, start first." }),
    },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["point_out_of_bounds", "no_home"],
} as const satisfies CapabilityDef;

export const estimateCost = {
  name: "estimateCost",
  kind: "compute",
  description:
    "Ask what a tour would cost: the route goes through your points in order (at most 10), starting from from (default: where you are), each leg planned on your own map. " +
    "It returns the total and, per leg, status, lengthM, etaS and energyPct; the total is found only if every leg is. Use it before you commit to a sequence of visits or to see whether you can get home. " +
    "Failures: point_out_of_bounds, no_home.",
  params: Type.Object({ route: Type.Array(Point, { minItems: 1, maxItems: COMPUTE_LIMITS.maxRoutePoints, description: "The points to visit, in order." }), from: Type.Optional(Point) }, { additionalProperties: false }),
  result: Type.Object(
    {
      status: Status,
      ...Figures,
      legs: Type.Array(Type.Object({ status: Status, ...Figures }, { additionalProperties: false }), { maxItems: COMPUTE_LIMITS.maxRoutePoints }),
    },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["point_out_of_bounds", "no_home"],
} as const satisfies CapabilityDef;

export const kShortestPaths = {
  name: "kShortestPaths",
  kind: "compute",
  description:
    "Ask for up to k (at most 3) different routes to a place on your own map, best first, each with lengthM, etaS and energyPct and sharedPct, the share of its length it has in common with the best one. " +
    "Use it when the best route may be risky or you want a way round. Fewer than k routes come back when the map has no more. from defaults to where you are. " +
    "Failures: point_out_of_bounds, no_home.",
  params: Type.Object(
    { to: Point, k: Type.Integer({ minimum: 1, maximum: COMPUTE_LIMITS.maxAlternatives, description: "How many routes, 1 to 3." }), from: Type.Optional(Point) },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      status: Status,
      expansions: Type.Integer({ description: "Nodes the searches expanded in all." }),
      paths: Type.Array(Type.Object({ ...Figures, sharedPct: Type.Number({ description: "Percent of this route's length it shares with the best route (0 for the best itself)." }) }, { additionalProperties: false }), {
        maxItems: COMPUTE_LIMITS.maxAlternatives,
      }),
    },
    { additionalProperties: false },
  ),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["point_out_of_bounds", "no_home"],
} as const satisfies CapabilityDef;

export const querySpace = {
  name: "querySpace",
  kind: "compute",
  description:
    "Read your own topological summary of space again, or the detail of one region. Without region you get the summary your request already carried (regions, frontiers, what is left out); with a region id " +
    "you get that region's known and free share, zones, waypoint and edges, and the frontiers that lie in it. It reads only your own map. Failure: unknown_region.",
  params: Type.Object({ region: Type.Optional(Type.String({ maxLength: 64, description: "A region id from the summary, e.g. R3." })) }, { additionalProperties: false }),
  result: Type.Object({ summary: Type.Optional(Type.Unknown({ description: "The whole summary (no region asked)." })), region: Type.Optional(Type.Unknown({ description: "The region's entry." })), frontiers: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false }),
  vehicles: ["uav", "ugv"],
  scope: "self",
  preconditions: [],
  failureCodes: ["unknown_region"],
} as const satisfies CapabilityDef;
