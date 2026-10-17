import Type from "typebox";

/**
 * Planning strategy document (ADR-0037, accepted 2026-10-13): untrusted data describing how an agent's `goTo` planner
 * combines the built-in algorithms. It lives here, next to the planner that will execute it (F2b M2), like the cost
 * profile. Never code: conditions are expressions of the whitelisted grammar over a fixed context
 * (`PLANNING_CONDITION_CONTEXT`).
 */
export const STRATEGY_SCHEMA_VERSION = 0;

/** ADR-0037 §1 limits; the weight and budget ranges are the planner's own (`PLANNING_LIMITS`, checked by a test). */
export const STRATEGY_LIMITS = {
  maxBytes: 16 * 1024,
  maxDepth: 6,
  maxNodes: 32,
  maxFallbackStages: 4,
  maxAnytimeWeights: 6,
  /** Legs of a `refine` node; enforced when the coarse path is known (thinned deterministically above it). */
  maxLegs: 64,
  minWeight: 1,
  maxWeight: 10,
  maxStageBudget: 10_000_000,
  maxConditionLength: 256,
} as const;

export const STRATEGY_ALGORITHMS = ["dijkstra", "astar", "weighted-astar", "hpa"] as const;
export type StrategyAlgorithm = (typeof STRATEGY_ALGORITHMS)[number];
export type StrategyHeuristic = "octile" | "euclidean";

export interface AlgorithmNode {
  readonly kind: "algorithm";
  readonly algorithm: StrategyAlgorithm;
  /** `weighted-astar` only, in [1, 10]. */
  readonly weight?: number;
  /** `astar` and `weighted-astar` only; default octile. */
  readonly heuristic?: StrategyHeuristic;
  /** Expansions this search may spend (ADR-0037 §3); at most the agent's `totalBudget`. */
  readonly stageBudget?: number;
}
/** Weighted A* passes with a decreasing weight list; returns the best completed path. */
export interface AnytimeNode {
  readonly kind: "anytime";
  readonly weights: readonly number[];
  readonly heuristic?: StrategyHeuristic;
  readonly stageBudget?: number;
}
export interface SelectNode {
  readonly kind: "select";
  readonly branches: readonly { readonly when: string; readonly then: StrategyNode }[];
  readonly else: StrategyNode;
}
export interface FallbackNode {
  readonly kind: "fallback";
  readonly stages: readonly StrategyNode[];
}
export interface RefineNode {
  readonly kind: "refine";
  readonly coarse: StrategyNode;
  readonly local: StrategyNode;
  readonly mode: "eager" | "lazy";
}
export type StrategyNode = AlgorithmNode | AnytimeNode | SelectNode | FallbackNode | RefineNode;

export interface PlanningStrategy {
  readonly schemaVersion: typeof STRATEGY_SCHEMA_VERSION;
  readonly id: string;
  readonly version: number;
  readonly description?: string;
  readonly origin?: "human" | "llm";
  readonly root: StrategyNode;
}

/** Reference to a shipped (later: library) strategy, as a run-configuration entry names it. */
export interface StrategyRef {
  readonly ref: string;
  readonly version: number;
}

export const StrategyId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });

const Num = Type.Number({ minimum: -1e9, maximum: 1e9 });
const Heuristic = Type.Union([Type.Literal("octile"), Type.Literal("euclidean")]);
/** Ranges that have their own stable codes (weights, budgets) are checked by the validator, not here. */
const StageBudget = Type.Integer({ minimum: -1e9, maximum: 1e9 });

/**
 * One schema per node kind, shallow: children are `Unknown` here and checked node by node by the validator, which walks
 * the tree with an explicit stack bounded by the depth and node limits (so a hostile document cannot recurse deeply).
 */
export const DocumentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(STRATEGY_SCHEMA_VERSION),
    id: StrategyId,
    version: Type.Integer({ minimum: 1, maximum: 0x7fffffff }),
    description: Type.Optional(Type.String({ maxLength: 512 })),
    origin: Type.Optional(Type.Union([Type.Literal("human"), Type.Literal("llm")])),
    root: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const NodeSchemas = {
  algorithm: Type.Object(
    {
      kind: Type.Literal("algorithm"),
      algorithm: Type.String({ maxLength: 32 }),
      weight: Type.Optional(Num),
      heuristic: Type.Optional(Heuristic),
      stageBudget: Type.Optional(StageBudget),
    },
    { additionalProperties: false },
  ),
  anytime: Type.Object(
    {
      kind: Type.Literal("anytime"),
      weights: Type.Array(Num, { minItems: 1, maxItems: 64 }),
      heuristic: Type.Optional(Heuristic),
      stageBudget: Type.Optional(StageBudget),
    },
    { additionalProperties: false },
  ),
  select: Type.Object(
    {
      kind: Type.Literal("select"),
      branches: Type.Array(
        Type.Object({ when: Type.String({ maxLength: STRATEGY_LIMITS.maxConditionLength }), then: Type.Unknown() }, { additionalProperties: false }),
        { minItems: 1, maxItems: STRATEGY_LIMITS.maxNodes },
      ),
      else: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  fallback: Type.Object(
    { kind: Type.Literal("fallback"), stages: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 64 }) },
    { additionalProperties: false },
  ),
  refine: Type.Object(
    {
      kind: Type.Literal("refine"),
      coarse: Type.Unknown(),
      local: Type.Unknown(),
      mode: Type.Union([Type.Literal("eager"), Type.Literal("lazy")]),
    },
    { additionalProperties: false },
  ),
} as const;

export type NodeKind = keyof typeof NodeSchemas;
export const NODE_KINDS = Object.keys(NodeSchemas) as readonly NodeKind[];
