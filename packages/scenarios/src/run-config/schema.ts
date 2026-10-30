import { CostProfile, PlanningStrategyDocument, StrategyId } from "@agentsim/algorithms";
import { S2Overrides, S2Profile } from "@agentsim/minds";
import Type, { type Static } from "typebox";
import { AgentKey, DriveFields, ScenarioId } from "../schema.ts";

/**
 * Run configuration document v0 (ADR-0028): what to run (scenario version, seed, time mode) and the
 * per-agent planning model. Ranges that have their own ADR-0028 error codes (weights, budgets) are
 * checked by the resolver, not here, so the codes reach the user.
 */
export const RUN_CONFIG_SCHEMA_VERSION = 0;
export const RUN_CONFIG_MAX_BYTES = 1024 * 1024;

export const AlgorithmSpec = Type.Union([
  Type.Literal("dijkstra"),
  Type.Literal("astar"),
  Type.Literal("hpa"),
  Type.Object({ "weighted-astar": Type.Object({ weight: Type.Number({ minimum: -1e9, maximum: 1e9 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
]);
export type AlgorithmSpec = Static<typeof AlgorithmSpec>;

/**
 * A planning strategy (ADR-0037): a shipped one by id and version, or an inline document. The inline document is checked
 * node by node at resolution (its own stable codes reach the user), not by this schema.
 */
export const StrategySpec = Type.Union([
  Type.Object({ ref: StrategyId, version: Type.Integer({ minimum: 1, maximum: 0x7fffffff }) }, { additionalProperties: false }),
  PlanningStrategyDocument,
]);
export type StrategySpec = Static<typeof StrategySpec>;

/**
 * Every field optional; later precedence levels override field by field. `algorithm` and `strategy` are one field for
 * precedence (ADR-0028 addition of 2026-10-13); one entry may set only one of them.
 */
export const PlanningEntry = Type.Object(
  {
    algorithm: Type.Optional(AlgorithmSpec),
    strategy: Type.Optional(StrategySpec),
    onboardComputeExpansionsPerTick: Type.Optional(Type.Integer({ minimum: 0, maximum: 1e9 })),
    totalBudget: Type.Optional(Type.Integer({ minimum: 0, maximum: 1e9 })),
    costProfile: Type.Optional(CostProfile),
    /** Exploration scope (ADR-0040): the radius of an iteration of `explore` in metres, and the margin its search windows add. */
    radiusM: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100_000 })),
    windowMarginM: Type.Optional(Type.Number({ minimum: 0, maximum: 100_000 })),
  },
  { additionalProperties: false },
);
export type PlanningEntry = Static<typeof PlanningEntry>;

/**
 * How an agent's belief map starts (ADR-0028 addition of 2026-10-09): `unknown` (built-in), a prior map from the
 * scenario, or `ideal` (ground truth, baselines only; labelled everywhere).
 */
export const BeliefInit = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("ideal"),
  Type.Object({ prior: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }) }, { additionalProperties: false }),
]);
export type BeliefInit = Static<typeof BeliefInit>;
export const BeliefsEntry = Type.Object({ init: Type.Optional(BeliefInit) }, { additionalProperties: false });
export type BeliefsEntry = Static<typeof BeliefsEntry>;

/**
 * Topological layer per agent (ADR-0039 §3), a traced experimental factor. `regionChunks` is range-checked at
 * resolution (`region_size_out_of_range`, [1, 16]); the other limits are part of the schema.
 */
export const TopologyEntry = Type.Object(
  {
    abstraction: Type.Optional(Type.Literal("grid-sectors-v0")),
    regionChunks: Type.Optional(Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 })),
    maxRegions: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    maxFrontiers: Type.Optional(Type.Integer({ minimum: 0, maximum: 32 })),
    minFrontierCells: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
  },
  { additionalProperties: false },
);
export type TopologyEntry = Static<typeof TopologyEntry>;

/** Ground drive overrides (ADR-0033); same precedence as planning entries. Applies to UGVs only. */
export const DriveEntry = Type.Object({ ...DriveFields }, { additionalProperties: false });
export type DriveEntry = Static<typeof DriveEntry>;

/**
 * A mind profile of the `s1` shape that is a script (ADR-0036 section 3, and its addition of 2026-10-26): the `sequence` script, a list of actions with arguments. The steps are checked
 * against the capability manifest at resolution (their own error names the step), not by this schema, which only bounds what a document can hold.
 */
export const MissionStep = Type.Object({ action: Type.String({ minLength: 1, maxLength: 64 }), args: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.Unknown(), { maxProperties: 16 })) }, { additionalProperties: false });
const S1Entry = Type.Object(
  { script: Type.Object({ name: Type.Literal("sequence"), params: Type.Object({ steps: Type.Array(MissionStep, { maxItems: 256 }) }, { additionalProperties: false }) }, { additionalProperties: false }) },
  { additionalProperties: false },
);
export type S1Entry = Static<typeof S1Entry>;

/**
 * The `s2` entry of a mind (ADR-0036 addition of 2026-10-29): a profile of the library by `{ id, version }` or an inline `s2` profile, optional overrides of its fields, and the mission in
 * natural language (at most 2,000 characters; it fills the prompt's mission slot and is part of both hashes).
 */
export const S2Entry = Type.Object(
  {
    profile: Type.Union([Type.Object({ id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), S2Profile]),
    overrides: Type.Optional(S2Overrides),
    mission: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type S2Entry = Static<typeof S2Entry>;

/** An entry has `s1` or `s2`, not both until F5 (`mind_shape_mismatch`, checked at resolution) and not neither. */
export const MindEntry = Type.Object({ s1: Type.Optional(S1Entry), s2: Type.Optional(S2Entry) }, { additionalProperties: false });
export type MindEntry = Static<typeof MindEntry>;

export const RunConfigDocument = Type.Object(
  {
    schemaVersion: Type.Literal(RUN_CONFIG_SCHEMA_VERSION),
    scenario: Type.Object({ id: ScenarioId, version: Type.Integer({ minimum: 1, maximum: 0x7fffffff }) }, { additionalProperties: false }),
    /** Overrides the scenario's defaultSeed. */
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffffffff })),
    /**
     * Where the minds' answers come from (ADR-0036 section 7): `live` calls providers and keeps every answer in the response cache, `replay-strict` reads the cache only (a miss stops the run),
     * `replay-then-live` reads the cache first and marks the run as not reproducible from the first call it has to make. Recorded in the run header, in neither hash.
     */
    mindsRunMode: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("replay-strict"), Type.Literal("replay-then-live")])),
    /** Default lockstep. `latency-modeled` arrives with minds. */
    timeMode: Type.Optional(Type.Union([Type.Literal("lockstep"), Type.Literal("realtime"), Type.Literal("latency-modeled")])),
    /**
     * Minimum sim time between decision requests for perception events (ADR-0005 addition of 2026-10-09), at run
     * level only: the same for every agent and every mind. Default 1 s; 0 = no limit.
     */
    minDecisionIntervalS: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
    planning: Type.Optional(
      Type.Object(
        {
          default: Type.Optional(PlanningEntry),
          byKind: Type.Optional(Type.Object({ uav: Type.Optional(PlanningEntry), ugv: Type.Optional(PlanningEntry) }, { additionalProperties: false })),
          byAgent: Type.Optional(Type.Record(AgentKey, PlanningEntry, { maxProperties: 1024, additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    drive: Type.Optional(
      Type.Object(
        {
          default: Type.Optional(DriveEntry),
          byKind: Type.Optional(Type.Object({ ugv: Type.Optional(DriveEntry) }, { additionalProperties: false })),
          byAgent: Type.Optional(Type.Record(AgentKey, DriveEntry, { maxProperties: 1024, additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    /** Belief-map initialization per agent (ADR-0028 addition of 2026-10-09); same precedence as planning, no scenario level. */
    beliefs: Type.Optional(
      Type.Object(
        {
          default: Type.Optional(BeliefsEntry),
          byKind: Type.Optional(Type.Object({ uav: Type.Optional(BeliefsEntry), ugv: Type.Optional(BeliefsEntry) }, { additionalProperties: false })),
          byAgent: Type.Optional(Type.Record(AgentKey, BeliefsEntry, { maxProperties: 1024, additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    /** The mind of an agent (ADR-0036 section 6; only the `s1` script `sequence` so far): default → byKind → byAgent, an entry replaces the one before it. Absent: the agent has no mind. */
    minds: Type.Optional(
      Type.Object(
        {
          default: Type.Optional(MindEntry),
          byKind: Type.Optional(Type.Object({ uav: Type.Optional(MindEntry), ugv: Type.Optional(MindEntry) }, { additionalProperties: false })),
          byAgent: Type.Optional(Type.Record(AgentKey, MindEntry, { maxProperties: 1024, additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    /** Topological layer per agent (ADR-0039 §3); same precedence as planning. */
    topology: Type.Optional(
      Type.Object(
        {
          default: Type.Optional(TopologyEntry),
          byKind: Type.Optional(Type.Object({ uav: Type.Optional(TopologyEntry), ugv: Type.Optional(TopologyEntry) }, { additionalProperties: false })),
          byAgent: Type.Optional(Type.Record(AgentKey, TopologyEntry, { maxProperties: 1024, additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type RunConfigDocument = Static<typeof RunConfigDocument>;
