import { compileExpr, err, ok, utf8, validate, xxHash32, type CodedError, type ExprErrorCode, type Result } from "@agentsim/core";
import type { CompiledCostProfile } from "../../cost-profile.ts";
import { PLANNING_CONDITION_CONTEXT } from "../planning-condition.ts";
import {
  DocumentSchema,
  NODE_KINDS,
  NodeSchemas,
  STRATEGY_ALGORITHMS,
  STRATEGY_LIMITS,
  STRATEGY_SCHEMA_VERSION,
  type NodeKind,
  type PlanningStrategy,
  type StrategyNode,
} from "./schema.ts";

/** Stable codes (ADR-0037 §9), plus document-level ones and the expression grammar's own (ADR-0026). */
export type StrategyErrorCode =
  | "invalid_json"
  | "unsupported_schema_version"
  | "invalid_strategy"
  | "strategy_too_large"
  | "strategy_too_deep"
  | "unknown_algorithm"
  | "weight_out_of_range"
  | "budget_out_of_range"
  | "anytime_weights_invalid"
  | "select_missing_else"
  | "condition_variable_unavailable"
  | "heuristic_not_admissible"
  | "stage_budget_exceeds_total"
  | "profile_feature_unsupported"
  | ExprErrorCode;

/** `path` points at the offending value (`/root/stages/1/branches/0/when`), so an editor can show it inline. */
export type StrategyError = CodedError<StrategyErrorCode> & { readonly path?: string };

export interface StrategyValidationOptions {
  /** Movement model of the space the strategy will run on; default 8-connected (every grid view today). */
  readonly movement?: "8-connected" | "4-connected";
  /** Condition variables the caller cannot provide (they fail with `condition_variable_unavailable`). */
  readonly unavailable?: readonly string[];
}

const fail = (code: StrategyErrorCode, message: string, path?: string): { ok: false; error: StrategyError } =>
  err(path === undefined ? { code, message } : { code, message, path });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses and validates JSON text: byte limit → JSON → schema version → schema and semantics. */
export function parsePlanningStrategy(text: string, opts: StrategyValidationOptions = {}): Result<PlanningStrategy, StrategyError> {
  if (text.length > STRATEGY_LIMITS.maxBytes || utf8(text).length > STRATEGY_LIMITS.maxBytes) {
    return fail("strategy_too_large", `planning strategies are limited to ${STRATEGY_LIMITS.maxBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return fail("invalid_json", e instanceof Error ? e.message.slice(0, 200) : "invalid JSON");
  }
  return validatePlanningStrategy(value, opts);
}

interface Item {
  readonly node: unknown;
  readonly path: string;
  readonly depth: number;
  /** A lazy refine may sit here: the root, or below select branches only (ADR-0037 fourth addition, item 9). */
  readonly lazyOk: boolean;
}

function inRange(w: number): boolean {
  return Number.isFinite(w) && w >= STRATEGY_LIMITS.minWeight && w <= STRATEGY_LIMITS.maxWeight;
}

/** Validates a planning strategy value; every failure has a stable code and the path of the offending value. */
export function validatePlanningStrategy(value: unknown, opts: StrategyValidationOptions = {}): Result<PlanningStrategy, StrategyError> {
  if (isRecord(value) && value["schemaVersion"] !== STRATEGY_SCHEMA_VERSION) {
    return fail("unsupported_schema_version", `unsupported planning strategy schemaVersion ${JSON.stringify(value["schemaVersion"])?.slice(0, 20)}`, "/schemaVersion");
  }
  const d = validate(DocumentSchema, value);
  if (!d.ok) {
    const first = d.error.issues[0];
    return fail("invalid_strategy", first ? `${first.path || "/"}: ${first.message}` : d.error.message, first?.path);
  }
  const movement = opts.movement ?? "8-connected";
  const unavailable = new Set(opts.unavailable ?? []);
  // An explicit stack in document order, bounded by the depth and node limits: a hostile document cannot recurse deeply.
  const stack: Item[] = [{ node: d.value.root, path: "/root", depth: 1, lazyOk: true }];
  let count = 0;
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, path, depth, lazyOk } = item;
    if (depth > STRATEGY_LIMITS.maxDepth) return fail("strategy_too_deep", `nesting deeper than ${STRATEGY_LIMITS.maxDepth} levels`, path);
    if (++count > STRATEGY_LIMITS.maxNodes) return fail("strategy_too_large", `more than ${STRATEGY_LIMITS.maxNodes} nodes`, path);
    if (!isRecord(node)) return fail("invalid_strategy", "a node must be an object", path);
    const kind = node["kind"];
    if (typeof kind !== "string" || !(NODE_KINDS as readonly string[]).includes(kind)) return fail("invalid_strategy", "unknown node kind", `${path}/kind`);
    const shape = validate(NodeSchemas[kind as NodeKind], node);
    if (!shape.ok) {
      const first = shape.error.issues[0];
      return fail("invalid_strategy", first ? `${first.path || "/"}: ${first.message}` : shape.error.message, `${path}${first?.path ?? ""}`);
    }
    const children: Item[] = [];
    const child = (n: unknown, sub: string, lazy = false) => children.push({ node: n, path: `${path}/${sub}`, depth: depth + 1, lazyOk: lazy });
    const checkBudget = (b: unknown) =>
      typeof b === "number" && (b < 1 || b > STRATEGY_LIMITS.maxStageBudget)
        ? fail("budget_out_of_range", `stageBudget must be an integer in [1, ${STRATEGY_LIMITS.maxStageBudget}]`, `${path}/stageBudget`)
        : undefined;
    const checkHeuristic = (h: unknown) =>
      h === "octile" && movement === "4-connected"
        ? fail("heuristic_not_admissible", "the octile heuristic overestimates on a space without diagonal moves; use euclidean", `${path}/heuristic`)
        : undefined;
    switch (kind) {
      case "algorithm": {
        const n = node as { algorithm: string; weight?: number; heuristic?: string; stageBudget?: number };
        if (!(STRATEGY_ALGORITHMS as readonly string[]).includes(n.algorithm)) {
          return fail("unknown_algorithm", `unknown algorithm '${n.algorithm.slice(0, 32)}' (available: ${STRATEGY_ALGORITHMS.join(", ")})`, `${path}/algorithm`);
        }
        if (n.algorithm === "weighted-astar") {
          if (n.weight === undefined) return fail("invalid_strategy", "weighted-astar needs a weight", `${path}/weight`);
          if (!inRange(n.weight)) return fail("weight_out_of_range", `weight must be in [${STRATEGY_LIMITS.minWeight}, ${STRATEGY_LIMITS.maxWeight}]`, `${path}/weight`);
        } else if (n.weight !== undefined) {
          return fail("invalid_strategy", `${n.algorithm} has no weight`, `${path}/weight`);
        }
        if (n.heuristic !== undefined && n.algorithm !== "astar" && n.algorithm !== "weighted-astar") {
          return fail("invalid_strategy", `${n.algorithm} has no heuristic parameter`, `${path}/heuristic`);
        }
        const bad = checkHeuristic(n.heuristic) ?? checkBudget(n.stageBudget);
        if (bad) return bad;
        break;
      }
      case "anytime": {
        const n = node as { weights: number[]; heuristic?: string; stageBudget?: number };
        if (n.weights.length > STRATEGY_LIMITS.maxAnytimeWeights) {
          return fail("strategy_too_large", `at most ${STRATEGY_LIMITS.maxAnytimeWeights} weights per anytime node`, `${path}/weights`);
        }
        for (const [i, w] of n.weights.entries()) {
          if (!inRange(w)) return fail("weight_out_of_range", `weights must be in [${STRATEGY_LIMITS.minWeight}, ${STRATEGY_LIMITS.maxWeight}]`, `${path}/weights/${i}`);
        }
        for (let i = 1; i < n.weights.length; i++) {
          if ((n.weights[i] ?? 0) >= (n.weights[i - 1] ?? 0)) return fail("anytime_weights_invalid", "weights must strictly decrease", `${path}/weights/${i}`);
        }
        const bad = checkHeuristic(n.heuristic) ?? checkBudget(n.stageBudget);
        if (bad) return bad;
        break;
      }
      case "select": {
        const n = node as { branches: { when: string; then: unknown }[]; else?: unknown };
        if (n.else === undefined) return fail("select_missing_else", "a select node needs an else branch", `${path}/else`);
        for (const [i, b] of n.branches.entries()) {
          const c = compileExpr(b.when, PLANNING_CONDITION_CONTEXT, "boolean");
          const at = `${path}/branches/${i}/when`;
          if (!c.ok) return fail(c.error.code, `${c.error.message} (at ${c.error.position})`, at);
          const missing = c.value.variables.find((v) => unavailable.has(v));
          if (missing !== undefined) return fail("condition_variable_unavailable", `'${missing}' is not available here`, at);
        }
        n.branches.forEach((b, i) => child(b.then, `branches/${i}/then`, lazyOk));
        child(n.else, "else", lazyOk);
        break;
      }
      case "fallback": {
        const n = node as { stages: unknown[] };
        if (n.stages.length > STRATEGY_LIMITS.maxFallbackStages) {
          return fail("strategy_too_large", `at most ${STRATEGY_LIMITS.maxFallbackStages} stages per fallback node`, `${path}/stages`);
        }
        if (n.stages.length < 2) return fail("invalid_strategy", "a fallback node needs at least two stages", `${path}/stages`);
        n.stages.forEach((s, i) => child(s, `stages/${i}`));
        break;
      }
      case "refine": {
        const n = node as { mode: string; coarse: unknown; local: unknown };
        if (n.mode === "lazy" && !lazyOk) {
          return fail("invalid_strategy", "a lazy refine must be the root or sit below select branches only: under a fallback a later failure would contradict legs already handed out, and inside another refine its legs are not the path the action drives", path);
        }
        child(n.coarse, "coarse");
        child(n.local, "local");
        break;
      }
    }
    // Reverse push: the next pop is the first child, so errors are reported in document order.
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i];
      if (c) stack.push(c);
    }
  }
  return ok(d.value as unknown as PlanningStrategy);
}

/** Every algorithm leaf and anytime node of a validated strategy, in document order (bounded by the node limit). */
function leaves(root: StrategyNode): { readonly node: StrategyNode; readonly path: string }[] {
  const out: { node: StrategyNode; path: string }[] = [];
  const stack: { node: StrategyNode; path: string }[] = [{ node: root, path: "/root" }];
  for (let it = stack.pop(); it !== undefined; it = stack.pop()) {
    const { node, path } = it;
    const kids: { node: StrategyNode; path: string }[] = [];
    if (node.kind === "algorithm" || node.kind === "anytime") out.push(it);
    else if (node.kind === "select") {
      node.branches.forEach((b, i) => kids.push({ node: b.then, path: `${path}/branches/${i}/then` }));
      kids.push({ node: node.else, path: `${path}/else` });
    } else if (node.kind === "fallback") node.stages.forEach((s, i) => kids.push({ node: s, path: `${path}/stages/${i}` }));
    else {
      kids.push({ node: node.coarse, path: `${path}/coarse` }, { node: node.local, path: `${path}/local` });
    }
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k) stack.push(k);
    }
  }
  return out;
}

/**
 * Checks a validated strategy against one agent's resolved budgets and cost profile (ADR-0037 §9): a stage cannot
 * be given more expansions than the query's `totalBudget`, and an `hpa` leaf cannot run under a turn-aware profile
 * (the same rule `validatePlanningConfig` applies to a plain `hpa` entry).
 */
export function checkStrategyForAgent(
  strategy: Pick<PlanningStrategy, "root">,
  agent: { readonly totalBudget: number; readonly profile: CompiledCostProfile },
): Result<void, StrategyError> {
  for (const { node, path } of leaves(strategy.root)) {
    if ((node.kind === "algorithm" || node.kind === "anytime") && node.stageBudget !== undefined && node.stageBudget > agent.totalBudget) {
      return fail("stage_budget_exceeds_total", `stageBudget ${node.stageBudget} is above the agent's totalBudget ${agent.totalBudget}`, `${path}/stageBudget`);
    }
    if (node.kind === "algorithm" && node.algorithm === "hpa" && agent.profile.turnAware) {
      return fail("profile_feature_unsupported", "turn costs/constraints are not supported by hpa", `${path}/algorithm`);
    }
  }
  return ok(undefined);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canonical(x);
    }
    return out;
  }
  return v;
}

/**
 * Content hash of what a strategy does: id, version and tree (key order and metadata such as `description` and
 * `origin` do not matter), as 8 hex digits. It enters `effectiveConfigHash` and the per-agent `config` record.
 */
export function strategyContentHash(s: PlanningStrategy): string {
  return xxHash32(utf8(JSON.stringify(canonical({ id: s.id, version: s.version, root: s.root }))), 0).toString(16).padStart(8, "0");
}
