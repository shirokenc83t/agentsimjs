import { compileExpr, err, ok, utf8, validate, xxHash32, type CodedError, type CompiledExpr, type ExprContext, type Result } from "@agentsim/core";
import Type, { type Static } from "typebox";

/**
 * Cost profiles (ADR-0014, ADR-0026): untrusted data — a weighted combination of named features plus
 * whitelisted constraints. Trusted native cost functions are referenced by name only (none in F1).
 */
const Weight = Type.Number({ minimum: 0, maximum: 1000 });

export const CostProfile = Type.Object(
  {
    weights: Type.Optional(
      Type.Record(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9]{0,31}$" }), Weight, { maxProperties: 16 }),
    ),
    constraints: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 16 })),
    native: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type CostProfile = Static<typeof CostProfile>;

/**
 * Supported features. `unknown` (F2) multiplies the cost of moving into a cell the agent has never observed
 * (ADR-0014; ADR-0028 addition of 2026-10-09): built-in 1, i.e. optimistic (unknown costs what free ground costs).
 * `radioCoverage` (F7), `risk` and `altitudeChange` (variable-altitude planning) come later.
 */
export const FEATURES = ["distance", "time", "energy", "terrain", "turn", "unknown"] as const;
export type Feature = (typeof FEATURES)[number];
/** @deprecated F1 name of the feature list; use FEATURES. */
export const F1_FEATURES = FEATURES;

/** Constraint variables (ADR-0026): cell attributes are precomputed into masks; edge terms are lazy. */
export const CELL_VARIABLES = ["altitude", "terrain", "slope", "vehicle"] as const;
export const EDGE_VARIABLES = ["distance", "turn"] as const;

export const COST_CONTEXT: ExprContext = {
  altitude: { type: "number" },
  terrain: { type: "number" },
  slope: { type: "number" },
  vehicle: { type: "enum", values: ["uav", "ugv"] },
  distance: { type: "number" },
  turn: { type: "number" },
};

export type CostProfileErrorCode = "invalid_profile" | "profile_feature_unsupported" | "native_unknown" | "profile_degenerate" | "constraint_invalid";
export type CostProfileError = CodedError<CostProfileErrorCode>;

export interface CompiledCostProfile {
  readonly weights: Readonly<Record<Feature, number>>;
  /** Constraints referencing only cell variables: precomputed into a per-cell mask. */
  readonly cellConstraints: readonly CompiledExpr[];
  /** Constraints referencing an edge variable (distance, turn): evaluated lazily per edge. */
  readonly edgeConstraints: readonly CompiledExpr[];
  /** True if turns matter (weight or constraint): the search state includes the heading. */
  readonly turnAware: boolean;
  /** Hash of the canonical profile (cache keys, run-config hash). */
  readonly hash: number;
  readonly canonical: string;
}

/** Default when no profile is given: shortest distance. */
export const DEFAULT_COST_PROFILE: CostProfile = { weights: { distance: 1 } };

/** Validates and compiles a cost profile; every failure has a stable code (ADR-0028). */
export function compileCostProfile(input: unknown): Result<CompiledCostProfile, CostProfileError> {
  const v = validate(CostProfile, input);
  if (!v.ok) return err({ code: "invalid_profile", message: v.error.message, details: v.error.issues });
  const p = v.value;
  if (p.native !== undefined) return err({ code: "native_unknown", message: `no trusted native cost function '${p.native}' is registered` });
  const weights: Record<Feature, number> = { distance: 0, time: 0, energy: 0, terrain: 0, turn: 0, unknown: 1 };
  for (const [k, w] of Object.entries(p.weights ?? { distance: 1 }).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!(FEATURES as readonly string[]).includes(k)) {
      return err({ code: "profile_feature_unsupported", message: `feature '${k}' is not available (supported: ${FEATURES.join(", ")})` });
    }
    weights[k as Feature] = w;
  }
  // A profile must make movement cost something, or searches degenerate (every path costs 0).
  if (weights.distance + weights.time + weights.energy + weights.terrain <= 0) {
    return err({ code: "profile_degenerate", message: "at least one of distance, time, energy, terrain must have a positive weight" });
  }
  if (weights.unknown <= 0) return err({ code: "profile_degenerate", message: "the unknown weight must be positive (it multiplies the cost of unknown cells)" });
  const cellConstraints: CompiledExpr[] = [];
  const edgeConstraints: CompiledExpr[] = [];
  for (const [idx, src] of (p.constraints ?? []).entries()) {
    const c = compileExpr(src, COST_CONTEXT, "boolean");
    if (!c.ok) return err({ code: "constraint_invalid", message: `constraint ${idx + 1}: ${c.error.message}`, details: c.error });
    if (c.value.variables.some((n) => (EDGE_VARIABLES as readonly string[]).includes(n))) edgeConstraints.push(c.value);
    else cellConstraints.push(c.value);
  }
  const canonical = JSON.stringify({ weights, constraints: p.constraints ?? [] });
  return ok({
    weights,
    cellConstraints,
    edgeConstraints,
    turnAware: weights.turn > 0 || edgeConstraints.some((c) => c.variables.includes("turn")),
    hash: xxHash32(utf8(canonical), 0),
    canonical,
  });
}
