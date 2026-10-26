import {
  DEFAULT_COST_PROFILE,
  DEFAULT_PLANNING_CONFIG,
  presetStrategy,
  strategyContentHash,
  strategyFacts,
  validatePlanningConfig,
  validatePlanningStrategy,
  type CostProfile,
  type PlanningAlgorithm,
  type PlanningConfig,
  type PlanningStrategy,
  type StrategyErrorCode,
  type StrategyNode,
  type StrategyRef,
} from "@agentsim/algorithms";
import { err, ok, validate, type CodedError, type Result } from "@agentsim/core";
import { BUILTIN_BODY_DEFAULTS, resolveBody, type BodyDefaults, type ResolvedUavBody, type ResolvedUgvBody } from "../body-defaults.ts";
import { DEFAULT_TOPOLOGY, TOPOLOGY_LIMITS, type TopologyConfig } from "@agentsim/spatial";
import { validateSequence } from "@agentsim/core";
import { toolsSchemaCapabilities } from "../assemble/capabilities.ts";
import { canonicalJson, hash32Hex } from "../canonical.ts";
import type { ScenarioAgentsView } from "../load.ts";
import { utf8Length } from "../validate.ts";
import { PlanningEntry, type MindEntry, RUN_CONFIG_MAX_BYTES, RUN_CONFIG_SCHEMA_VERSION, RunConfigDocument, type AlgorithmSpec, type BeliefInit } from "./schema.ts";

/** Stable codes (ADR-0028), plus document-level ones and the cost-profile codes of ADR-0014/0026. */
export type RunConfigErrorCode =
  | "too_large"
  | "invalid_json"
  | "unsupported_schema_version"
  | "invalid_document"
  | "scenario_version_not_found"
  | "unknown_agent_key"
  | "algorithm_space_mismatch"
  | "profile_feature_unsupported"
  | "weight_out_of_range"
  | "budget_out_of_range"
  | "invalid_profile"
  | "native_unknown"
  | "profile_degenerate"
  | "constraint_invalid"
  | "prior_not_found"
  | "region_size_out_of_range"
  | "strategy_not_found"
  | "strategy_and_algorithm_both_set"
  | "invalid_mission"
  | StrategyErrorCode;

export type RunConfigError = CodedError<RunConfigErrorCode> & { readonly path?: string };

/** Precedence levels, lowest first (ADR-0028); `runtime` = a world-scope change during the run. */
export type ConfigLevel = "builtin" | "scenario" | "default" | "byKind" | "byAgent" | "runtime";
export type PlanningField = "algorithm" | "onboardComputeExpansionsPerTick" | "totalBudget" | "costProfile" | "radiusM" | "windowMarginM";

/**
 * Built-in exploration scope (ADR-0040): the radius of an iteration of `explore` per vehicle kind, and the margin of its search windows.
 * Fixed by the F2c M1 measurements (ADR-0040 addition of 2026-10-19, "values and retries").
 */
export const EXPLORE_BUILTIN = { radiusM: { uav: 40, ugv: 20 }, windowMarginM: 10 } as const;

/**
 * A planning strategy as resolved for an agent (ADR-0037 §4): what it does (id, version, tree) and its content hash.
 * Metadata (`description`, `origin`) and how it was named (reference or inline) are not part of it, so the same
 * behavior hashes alike however it was written.
 */
export interface ResolvedStrategy {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly root: StrategyNode;
}

export interface EffectiveAgentConfig {
  readonly agentId: string;
  readonly key?: string;
  readonly kind: "uav" | "ugv";
  /**
   * Resolved planning entry in document form (as hashed and shown in the UI). With a `strategy`, `algorithm` is the
   * built-in one (a placeholder that keeps two ways to the same behavior hashing alike); without, there is no
   * `strategy` key, so plain configurations are byte for byte what they were before ADR-0037.
   */
  readonly planning: {
    readonly algorithm: AlgorithmSpec;
    readonly strategy?: ResolvedStrategy;
    readonly onboardComputeExpansionsPerTick: number;
    readonly totalBudget: number;
    readonly costProfile: CostProfile;
    /** Radius of an iteration of `explore`, metres (ADR-0040). */
    readonly radiusM: number;
    /** Margin of the search windows of `explore`, metres (ADR-0040). */
    readonly windowMarginM: number;
  };
  /** Which level supplied each planning field (Inspector, ADR-0028). */
  readonly planningSources: Readonly<Record<PlanningField, ConfigLevel>>;
  /** Body parameters resolved over the built-ins; footprint and tracking margin change paths, so they are hashed. */
  readonly body: ResolvedUavBody | ResolvedUgvBody;
  /**
   * How the agent's belief map starts (ADR-0028 addition of 2026-10-09). `idealized` marks `ideal` agents, whose map
   * is ground truth: labelled in the run header, their `config` records and the UI.
   */
  readonly beliefs: {
    readonly init: BeliefInit;
    readonly idealized: boolean;
    /** The chosen prior's content hash (`init: { prior }` only), so a changed prior changes `effectiveConfigHash`. */
    readonly priorHash?: string;
  };
  readonly beliefsSource: ConfigLevel;
  /** Topological layer (ADR-0039 §3), resolved field by field: built-in → default → byKind → byAgent. */
  readonly topology: TopologyConfig;
  /** The agent's mind when the run configuration gives it one (a mission, validated against the capability manifest); absent otherwise, and then in no hash. */
  readonly mind?: MindEntry;
}

/**
 * A non-blocking remark on a resolved configuration (ADR-0037 seventh addition, item 15): shown inline in the lab, outside
 * every hash, never a reason to refuse a run.
 */
export interface RunConfigWarning {
  readonly code: "lazy_refine_on_belief_map";
  readonly agentId: string;
  readonly message: string;
  readonly path: string;
}

export interface ResolvedRunConfig {
  readonly document: RunConfigDocument;
  readonly scenario: { readonly id: string; readonly version: number };
  readonly seed: number;
  readonly timeMode: "lockstep" | "realtime";
  /** Minimum sim time between decision requests for perception events (ADR-0005 addition); default 1 s. */
  readonly minDecisionIntervalS: number;
  /** Sorted by agent ID. */
  readonly agents: readonly EffectiveAgentConfig[];
  /** Non-blocking remarks, in agent order; not part of any hash. */
  readonly warnings: readonly RunConfigWarning[];
  /** What the user asked for: the canonical document, defaults omitted. */
  readonly runConfigHash: string;
  /** What the simulator used: every agent's resolved configuration. */
  readonly effectiveConfigHash: string;
}

export interface ResolveOptions {
  /** Injected in tests to simulate a changed built-in default. */
  readonly builtinPlanning?: PlanningConfig;
  readonly builtinBodies?: BodyDefaults;
  /** Finds a strategy by reference: the shipped presets by default (the library arrives with F5). */
  readonly strategies?: (ref: StrategyRef) => PlanningStrategy | undefined;
}

const fail = (code: RunConfigErrorCode, message: string, path?: string): { ok: false; error: RunConfigError } =>
  err(path === undefined ? { code, message } : { code, message, path });

export function parseRunConfig(text: string): Result<RunConfigDocument, RunConfigError> {
  if (text.length > RUN_CONFIG_MAX_BYTES || utf8Length(text) > RUN_CONFIG_MAX_BYTES) {
    return fail("too_large", `run configurations are limited to ${RUN_CONFIG_MAX_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return fail("invalid_json", e instanceof Error ? e.message.slice(0, 200) : "invalid JSON");
  }
  return parseRunConfigValue(value);
}

export function parseRunConfigValue(value: unknown): Result<RunConfigDocument, RunConfigError> {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof value === "object" && value !== null && version !== RUN_CONFIG_SCHEMA_VERSION) {
    return fail("unsupported_schema_version", `unsupported run configuration schemaVersion ${JSON.stringify(version)?.slice(0, 20)}`, "/schemaVersion");
  }
  const r = validate(RunConfigDocument, value);
  if (!r.ok) {
    const first = r.error.issues[0];
    return fail("invalid_document", first ? `${first.path || "/"}: ${first.message}` : r.error.message, first?.path);
  }
  return ok(r.value);
}

/** Canonical form for `runConfigHash`: keys sorted, defaults and empty sections omitted. */
export function canonicalRunConfig(doc: RunConfigDocument): string {
  const prune = (v: unknown): unknown => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p === undefined) continue;
      if (p !== null && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  };
  const { timeMode, minDecisionIntervalS, ...rest } = doc;
  // Defaults are omitted: an explicit lockstep or an explicit 1 s hashes like an absent field.
  return canonicalJson(prune({ ...rest, ...(timeMode === "realtime" ? { timeMode } : {}), ...(minDecisionIntervalS !== undefined && minDecisionIntervalS !== 1 ? { minDecisionIntervalS } : {}) }));
}

export function toPlanningAlgorithm(a: AlgorithmSpec): PlanningAlgorithm {
  if (typeof a === "string") return { kind: a };
  return { kind: "weighted-astar", weight: a["weighted-astar"].weight };
}

function fromPlanningAlgorithm(a: PlanningAlgorithm): AlgorithmSpec {
  return a.kind === "weighted-astar" ? { "weighted-astar": { weight: a.weight } } : a.kind;
}

/** Planning config as the PlanningService consumes it. */
export function toPlanningConfig(a: EffectiveAgentConfig): PlanningConfig {
  return {
    algorithm: toPlanningAlgorithm(a.planning.algorithm),
    onboardComputeExpansionsPerTick: a.planning.onboardComputeExpansionsPerTick,
    totalBudget: a.planning.totalBudget,
    costProfile: a.planning.costProfile,
    ...(a.planning.strategy ? { strategy: a.planning.strategy } : {}),
  };
}

const FIELDS: readonly PlanningField[] = ["algorithm", "onboardComputeExpansionsPerTick", "totalBudget", "costProfile", "radiusM", "windowMarginM"];

/**
 * Applies `entry` over `base` field by field, recording `level` as the source of each field it sets. `algorithm` and
 * `strategy` are one field for precedence: setting either replaces the planner of the earlier levels (ADR-0028 addition
 * of 2026-10-13). With a strategy, `algorithm` is reset to the built-in one.
 */
function overlay(
  base: EffectiveAgentConfig["planning"],
  sources: Record<PlanningField, ConfigLevel>,
  entry: PlanningEntry | undefined,
  level: ConfigLevel,
  strategy: ResolvedStrategy | undefined,
  builtinAlgorithm: AlgorithmSpec,
): EffectiveAgentConfig["planning"] {
  if (!entry) return base;
  const next: Record<string, unknown> = { ...base };
  for (const f of FIELDS) {
    const v = entry[f];
    if (v === undefined) continue;
    next[f] = v;
    sources[f] = level;
  }
  if (strategy) {
    next["strategy"] = strategy;
    next["algorithm"] = builtinAlgorithm;
    sources.algorithm = level;
  } else if (entry.algorithm !== undefined) delete next["strategy"];
  return next as unknown as EffectiveAgentConfig["planning"];
}

type StrategyLookup = (ref: StrategyRef) => PlanningStrategy | undefined;

/**
 * The strategy an entry names, validated (ADR-0037 §4, §9): `undefined` if it names none. A shipped strategy is found
 * by id and version and validated like an inline one, so a registry can never smuggle in an unchecked document.
 */
function resolveEntryStrategy(entry: PlanningEntry | undefined, path: string, lookup: StrategyLookup): Result<ResolvedStrategy | undefined, RunConfigError> {
  const spec = entry?.strategy;
  if (entry === undefined || spec === undefined) return ok(undefined);
  if (entry.algorithm !== undefined) return fail("strategy_and_algorithm_both_set", "a planning entry sets either algorithm or strategy, not both", path);
  const at = `${path}/strategy`;
  let candidate: unknown = spec;
  if ("ref" in spec) {
    candidate = lookup({ ref: spec.ref, version: spec.version });
    if (candidate === undefined) return fail("strategy_not_found", `no strategy "${spec.ref}" version ${spec.version}`, at);
  }
  const v = validatePlanningStrategy(candidate);
  if (!v.ok) return fail(v.error.code, v.error.message, `${at}${v.error.path ?? ""}`);
  return ok({ id: v.value.id, version: v.value.version, hash: strategyContentHash(v.value), root: v.value.root });
}

/**
 * A strategy named outside a run configuration (the researcher's sandbox, ADR-0037 seventh addition): a shipped one by
 * reference or an inline document, found and validated exactly as an entry's would be. Errors carry the path into the spec.
 */
export function resolveStrategySpec(spec: NonNullable<PlanningEntry["strategy"]>): Result<ResolvedStrategy, RunConfigError> {
  const r = resolveEntryStrategy({ strategy: spec }, "", presetStrategy);
  if (!r.ok) return r;
  return r.value ? ok(r.value) : fail("invalid_document", "no strategy given", "/strategy");
}

/** Validates one agent's resolved planning config with the ADR-0028 ranges, the profile compiler and its strategy. */
function checkAgent(a: EffectiveAgentConfig): Result<void, RunConfigError> {
  const r = validatePlanningConfig(toPlanningConfig(a));
  const who = a.key === undefined ? a.agentId : `${a.agentId} (${a.key})`;
  if (!r.ok) {
    // Config validation never sees query-only codes (endpoints, maps).
    const code = r.error.code === "invalid_endpoint" || r.error.code === "invalid_map" ? "invalid_profile" : r.error.code;
    const s = a.planningSources;
    const from =
      code === "weight_out_of_range" ? `algorithm from ${s.algorithm}`
      : code === "budget_out_of_range" ? `per-tick from ${s.onboardComputeExpansionsPerTick}, total from ${s.totalBudget}`
      : code === "stage_budget_exceeds_total" ? `strategy from ${s.algorithm}, total from ${s.totalBudget}`
      : `cost profile from ${s.costProfile}`;
    return fail(code, `${who}: ${r.error.message} (${from})`, `/agents/${a.agentId}`);
  }
  return ok(undefined);
}

/**
 * Resolves the effective configuration of every agent (ADR-0028): built-in → scenario body → run
 * `default` → `byKind` → `byAgent`, field by field. `scenario.version` is the stored version the
 * loaded document came from; it must be the one the run configuration names.
 */
export function resolveRunConfig(
  doc: RunConfigDocument,
  scenario: { readonly loaded: ScenarioAgentsView; readonly version: number },
  opts: ResolveOptions = {},
): Result<ResolvedRunConfig, RunConfigError> {
  const sdoc = scenario.loaded.document;
  if (doc.scenario.id !== sdoc.id || doc.scenario.version !== scenario.version) {
    return fail("scenario_version_not_found", `run configuration names ${doc.scenario.id} v${doc.scenario.version}, got ${sdoc.id} v${scenario.version}`, "/scenario");
  }
  const keys = new Set(scenario.loaded.agents.flatMap((a) => (a.key === undefined ? [] : [a.key])));
  for (const [section, entries] of [["planning", doc.planning?.byAgent], ["drive", doc.drive?.byAgent], ["beliefs", doc.beliefs?.byAgent], ["topology", doc.topology?.byAgent], ["minds", doc.minds?.byAgent]] as const) {
    for (const k of Object.keys(entries ?? {}).sort()) {
      if (!keys.has(k)) return fail("unknown_agent_key", `no agent with key "${k}" in scenario ${sdoc.id}`, `/${section}/byAgent/${k}`);
    }
  }
  const builtin = opts.builtinPlanning ?? DEFAULT_PLANNING_CONFIG;
  const bodies = opts.builtinBodies ?? BUILTIN_BODY_DEFAULTS;
  const builtinAlgorithm = fromPlanningAlgorithm(builtin.algorithm);
  // Every strategy the document names, resolved and validated once, in a fixed order (default, kinds, agent keys).
  const lookup: StrategyLookup = opts.strategies ?? presetStrategy;
  const strategies = new Map<PlanningEntry, ResolvedStrategy>();
  const named: [PlanningEntry | undefined, string][] = [
    [doc.planning?.default, "/planning/default"],
    [doc.planning?.byKind?.uav, "/planning/byKind/uav"],
    [doc.planning?.byKind?.ugv, "/planning/byKind/ugv"],
    ...Object.keys(doc.planning?.byAgent ?? {}).sort().map((k): [PlanningEntry | undefined, string] => [doc.planning?.byAgent?.[k], `/planning/byAgent/${k}`]),
  ];
  for (const [e, path] of named) {
    const s = resolveEntryStrategy(e, path, lookup);
    if (!s.ok) return s;
    if (e && s.value) strategies.set(e, s.value);
  }
  const agents: EffectiveAgentConfig[] = [];
  for (const a of [...scenario.loaded.agents].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    // Drive overrides (ADR-0033), same precedence as planning: default → byKind → byAgent, over the scenario body.
    const drive = { ...doc.drive?.default, ...doc.drive?.byKind?.ugv, ...(a.key === undefined ? {} : doc.drive?.byAgent?.[a.key]) };
    const body = a.kind === "uav" ? resolveBody("uav", a.body, bodies) : resolveBody("ugv", a.body, bodies, drive);
    const sources: Record<PlanningField, ConfigLevel> = { algorithm: "builtin", onboardComputeExpansionsPerTick: "builtin", totalBudget: "builtin", costProfile: "builtin", radiusM: "builtin", windowMarginM: "builtin" };
    let planning: EffectiveAgentConfig["planning"] = {
      algorithm: fromPlanningAlgorithm(builtin.algorithm),
      // The body's built-in compute is the built-in level for this field (ADR-0024 clarification).
      onboardComputeExpansionsPerTick: bodies[a.kind].onboardComputeExpansionsPerTick,
      totalBudget: builtin.totalBudget,
      costProfile: builtin.costProfile ?? DEFAULT_COST_PROFILE,
      radiusM: EXPLORE_BUILTIN.radiusM[a.kind],
      windowMarginM: EXPLORE_BUILTIN.windowMarginM,
    };
    const scenarioCompute = a.body.onboardComputeExpansionsPerTick;
    const apply = (entry: PlanningEntry | undefined, level: ConfigLevel) => {
      planning = overlay(planning, sources, entry, level, entry === undefined ? undefined : strategies.get(entry), builtinAlgorithm);
    };
    apply(scenarioCompute === undefined ? undefined : { onboardComputeExpansionsPerTick: scenarioCompute }, "scenario");
    apply(doc.planning?.default, "default");
    apply(doc.planning?.byKind?.[a.kind], "byKind");
    apply(a.key === undefined ? undefined : doc.planning?.byAgent?.[a.key], "byAgent");
    // Belief initialization: built-in `unknown` → default → byKind → byAgent (no scenario level, ADR-0028 addition).
    let init: BeliefInit = "unknown";
    let beliefsSource: ConfigLevel = "builtin";
    for (const [entry, level] of [
      [doc.beliefs?.default, "default"],
      [doc.beliefs?.byKind?.[a.kind], "byKind"],
      [a.key === undefined ? undefined : doc.beliefs?.byAgent?.[a.key], "byAgent"],
    ] as const) {
      if (entry?.init === undefined) continue;
      init = entry.init;
      beliefsSource = level;
    }
    let priorHash: string | undefined;
    if (typeof init === "object") {
      priorHash = Object.hasOwn(scenario.loaded.priorHashes ?? {}, init.prior) ? scenario.loaded.priorHashes?.[init.prior] : undefined;
      if (priorHash === undefined) return fail("prior_not_found", `${a.id}: no prior "${init.prior}" in scenario ${sdoc.id} (beliefs from ${beliefsSource})`, `/beliefs`);
    }
    const topology: TopologyConfig = {
      ...DEFAULT_TOPOLOGY,
      ...doc.topology?.default,
      ...doc.topology?.byKind?.[a.kind],
      ...(a.key === undefined ? {} : doc.topology?.byAgent?.[a.key]),
    };
    const [rcMin, rcMax] = TOPOLOGY_LIMITS.regionChunks;
    if (topology.regionChunks < rcMin || topology.regionChunks > rcMax) {
      return fail("region_size_out_of_range", `${a.id}: topology.regionChunks must be in [${rcMin}, ${rcMax}], got ${topology.regionChunks}`, "/topology");
    }
    // The mind (ADR-0036 section 6): an entry replaces the one before it (default → byKind → byAgent); a mission is checked against the capability manifest for this kind of vehicle.
    const mind: MindEntry | undefined = (a.key === undefined ? undefined : doc.minds?.byAgent?.[a.key]) ?? doc.minds?.byKind?.[a.kind] ?? doc.minds?.default;
    if (mind !== undefined) {
      const path = a.key !== undefined && doc.minds?.byAgent?.[a.key] !== undefined ? `/minds/byAgent/${a.key}` : doc.minds?.byKind?.[a.kind] !== undefined ? `/minds/byKind/${a.kind}` : "/minds/default";
      const v = validateSequence(mind.s1.script.params.steps, toolsSchemaCapabilities, a.kind);
      if (!v.ok) return fail("invalid_mission", `${a.id}: ${v.error.message}`, `${path}/s1/script/params/steps${v.error.step === undefined ? "" : `/${v.error.step - 1}`}`);
    }
    const eff: EffectiveAgentConfig = {
      agentId: a.id,
      ...(a.key === undefined ? {} : { key: a.key }),
      kind: a.kind,
      planning,
      planningSources: sources,
      body,
      beliefs: { init, idealized: init === "ideal", ...(priorHash === undefined ? {} : { priorHash }) },
      beliefsSource,
      topology,
      ...(mind === undefined ? {} : { mind }),
    };
    const c = checkAgent(eff);
    if (!c.ok) return c;
    agents.push(eff);
  }
  return ok({
    document: doc,
    scenario: { id: doc.scenario.id, version: doc.scenario.version },
    seed: doc.seed ?? sdoc.defaultSeed,
    timeMode: doc.timeMode ?? "lockstep",
    minDecisionIntervalS: doc.minDecisionIntervalS ?? 1,
    agents,
    warnings: warningsOf(agents),
    runConfigHash: hash32Hex(canonicalRunConfig(doc)),
    effectiveConfigHash: effectiveConfigHash(agents, doc.minDecisionIntervalS ?? 1),
  });
}

/**
 * A lazy refine hands legs out while it plans on; on a belief map that changes as the agent senses, a query that lasts many
 * ticks is interrupted again and again (measured, ADR-0037 sixth addition, item 13). Ideal agents plan on a map that does not change.
 */
function warningsOf(agents: readonly EffectiveAgentConfig[]): RunConfigWarning[] {
  return agents.flatMap((a) => agentWarnings(a));
}

/** The warnings of one agent's effective configuration: what the run-configuration panel and the Inspector show. */
export function agentWarnings(a: Pick<EffectiveAgentConfig, "agentId" | "planning" | "beliefs">): RunConfigWarning[] {
  const s = a.planning.strategy;
  if (!s || a.beliefs.idealized || !strategyFacts(s.root).lazyRefine) return [];
  return [
    {
      code: "lazy_refine_on_belief_map",
      agentId: a.agentId,
      message: `${a.agentId} plans on a belief map: a lazy refine of strategy "${s.id}" is interrupted by every map change that overlaps what it has read, which a moving, sensing agent causes constantly when queries last many ticks`,
      path: `/agents/${a.agentId}`,
    },
  ];
}

/** xxHash32 over the resolved per-agent configurations, agents in ID order (sources are not hashed). */
export function effectiveConfigHash(agents: readonly EffectiveAgentConfig[], minDecisionIntervalS = 1): string {
  return hash32Hex(canonicalJson({ minDecisionIntervalS, agents: agents.map((a) => ({ agentId: a.agentId, key: a.key, kind: a.kind, planning: a.planning, body: a.body, beliefs: a.beliefs, topology: a.topology, ...(a.mind === undefined ? {} : { mind: a.mind }) })) }));
}

/**
 * A world-scope runtime change (ADR-0028): `entry` overlays the agent's current effective planning
 * config. The caller applies the result from the agent's next query; queries in progress keep the
 * configuration they were submitted with (the PlanningService captures it per request).
 */
export function withRuntimeChange(agent: EffectiveAgentConfig, entry: PlanningEntry, opts: ResolveOptions = {}): Result<EffectiveAgentConfig, RunConfigError> {
  const v = validate(PlanningEntry, entry);
  if (!v.ok) return fail("invalid_document", v.error.message);
  const strategy = resolveEntryStrategy(entry, "/planning/runtime", opts.strategies ?? presetStrategy);
  if (!strategy.ok) return strategy;
  const sources = { ...agent.planningSources };
  const planning = overlay(agent.planning, sources, entry, "runtime", strategy.value, fromPlanningAlgorithm((opts.builtinPlanning ?? DEFAULT_PLANNING_CONFIG).algorithm));
  const next: EffectiveAgentConfig = { ...agent, planning, planningSources: sources };
  const c = checkAgent(next);
  return c.ok ? ok(next) : c;
}
