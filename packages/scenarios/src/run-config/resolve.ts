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
import { checkRanges, resolveS2, validateMindProfile, validatePromptTemplate, type EffectiveS2, type MindProfileDocument, type MindSource, type PromptTemplateDocument, type S2Profile } from "@agentsim/minds";
import { toolsSchemaCapabilities } from "../assemble/capabilities.ts";
import { canonicalJson, hash32Hex } from "../canonical.ts";
import type { ScenarioAgentsView } from "../load.ts";
import { utf8Length } from "../validate.ts";
import { PlanningEntry, type MindEntry, type S1Entry, RUN_CONFIG_MAX_BYTES, RUN_CONFIG_SCHEMA_VERSION, RunConfigDocument, type AlgorithmSpec, type BeliefInit } from "./schema.ts";

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
  | "mind_profile_not_found"
  | "prompt_template_not_found"
  | "provider_not_configured"
  | "mind_shape_mismatch"
  | "limit_out_of_range"
  | "template_slot_unknown"
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
  readonly mind?: { readonly s1: S1Entry };
  /** The agent's System 2 mind (F4) when the run configuration gives it one: absent otherwise, and then in no hash, so a configuration without one hashes as before. */
  readonly s2?: ResolvedS2Mind;
}

/**
 * The effective System 2 mind of an agent (ADR-0036 section 6): the profile resolved over the defaults and the overrides (each field with the level that supplied it), the prompt template's
 * content, the mission, and the provider as far as a hash may know it: its id, kind and the host of its endpoint. Never a key, a price or a path of the endpoint.
 */
export interface ResolvedS2Mind {
  /** The level of the run configuration that gave the entry. */
  readonly source: ConfigLevel;
  /** The library reference, absent for an inline profile. */
  readonly profileRef?: { readonly id: string; readonly version: number };
  readonly effective: Omit<EffectiveS2, "sources">;
  /** Where each field came from: `default`, `profile` or `override`. */
  readonly sources: Readonly<Record<string, MindSource>>;
  readonly template: { readonly id: string; readonly version: number; readonly content: PromptTemplateDocument };
  readonly mission?: string;
  readonly provider: { readonly id: string; readonly kind: string; readonly host: string };
}

/** The library the resolution reads profiles and templates from (a lookup the caller made ready from storage; the default has none). */
export interface MindLibrary {
  profile(id: string, version: number): MindProfileDocument | undefined;
  template(id: string, version: number): PromptTemplateDocument | undefined;
}

/** What the resolution knows of a provider entry of Settings: its kind and its endpoint. Anything else the entry holds (a key, prices) is not read. */
export interface ProviderInfo {
  readonly kind: string;
  readonly baseUrl: string;
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
  readonly timeMode: "lockstep" | "realtime" | "latency-modeled";
  /** Where the minds' answers come from (run header; in neither hash). */
  readonly mindsRunMode: "live" | "replay-strict" | "replay-then-live";
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
  /** Mind profiles and prompt templates by `{ id, version }`: needed by an `s2` entry that names a library profile (`mind_profile_not_found` without it). */
  readonly library?: MindLibrary;
  /** The provider entries of Settings by id (`provider_not_configured` when an `s2` mind names one this does not know). */
  readonly providers?: (id: string) => ProviderInfo | undefined;
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
  // `mindsRunMode` says where the minds' answers come from, not what they decide: it is in no hash.
  const { timeMode, minDecisionIntervalS, mindsRunMode: _runMode, ...rest } = doc;
  // Defaults are omitted: an explicit lockstep or an explicit 1 s hashes like an absent field.
  return canonicalJson(prune({ ...rest, ...(timeMode === "realtime" || timeMode === "latency-modeled" ? { timeMode } : {}), ...(minDecisionIntervalS !== undefined && minDecisionIntervalS !== 1 ? { minDecisionIntervalS } : {}) }));
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
    // The mind (ADR-0036 section 6): an entry replaces the one before it (default → byKind → byAgent). An `s1` mission is checked against the capability manifest for this kind of vehicle; an `s2`
    // entry is resolved over the library and the provider entries (the profile's fields, the overrides, the template, the endpoint's host), field by field.
    const byAgent = a.key === undefined ? undefined : doc.minds?.byAgent?.[a.key];
    const mind: MindEntry | undefined = byAgent ?? doc.minds?.byKind?.[a.kind] ?? doc.minds?.default;
    let s1: { s1: S1Entry } | undefined;
    let s2: ResolvedS2Mind | undefined;
    if (mind !== undefined) {
      const level: ConfigLevel = byAgent !== undefined ? "byAgent" : doc.minds?.byKind?.[a.kind] !== undefined ? "byKind" : "default";
      const path = level === "byAgent" ? `/minds/byAgent/${a.key}` : level === "byKind" ? `/minds/byKind/${a.kind}` : "/minds/default";
      if (mind.s1 !== undefined && mind.s2 !== undefined) return fail("mind_shape_mismatch", `${a.id}: an entry has s1 or s2, not both (s1+s2 is F5)`, path);
      if (mind.s1 === undefined && mind.s2 === undefined) return fail("invalid_document", `${a.id}: a mind entry needs s1 or s2`, path);
      if (mind.s1 !== undefined) {
        const v = validateSequence(mind.s1.script.params.steps, toolsSchemaCapabilities, a.kind);
        if (!v.ok) return fail("invalid_mission", `${a.id}: ${v.error.message}`, `${path}/s1/script/params/steps${v.error.step === undefined ? "" : `/${v.error.step - 1}`}`);
        s1 = { s1: mind.s1 };
      } else if (mind.s2 !== undefined) {
        const r = resolveS2Entry(a.id, mind.s2, level, `${path}/s2`, opts);
        if (!r.ok) return r;
        s2 = r.value;
      }
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
      ...(s1 === undefined ? {} : { mind: s1 }),
      ...(s2 === undefined ? {} : { s2 }),
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
    mindsRunMode: doc.mindsRunMode ?? "live",
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
  return hash32Hex(canonicalJson({ minDecisionIntervalS, agents: agents.map((a) => ({ agentId: a.agentId, key: a.key, kind: a.kind, planning: a.planning, body: a.body, beliefs: a.beliefs, topology: a.topology, ...(a.mind === undefined ? {} : { mind: a.mind }), ...(a.s2 === undefined ? {} : { s2: s2HashInput(a.s2) }) })) }));
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


/** What of an `s2` mind a hash sees (ADR-0036 section 6): the effective fields, the template's content, the mission and the provider's kind and host; never a key or a price, never where a field came from. */
export function s2HashInput(m: ResolvedS2Mind): unknown {
  return { effective: m.effective, template: m.template.content, mission: m.mission, provider: { kind: m.provider.kind, host: m.provider.host } };
}

/** The host of an endpoint (`localhost:11434`), or undefined for a text that is not a URL. Only the host is part of a hash: the path and anything after it may name a deployment, never a secret. */
function hostOf(baseUrl: string): string | undefined {
  const m = /^https?:\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(baseUrl);
  return m?.[1]?.toLowerCase();
}

function resolveS2Entry(agentId: string, entry: NonNullable<MindEntry["s2"]>, source: ConfigLevel, path: string, opts: ResolveOptions): Result<ResolvedS2Mind, RunConfigError> {
  let profile: S2Profile;
  let profileRef: { id: string; version: number } | undefined;
  if ("id" in entry.profile) {
    const ref = entry.profile;
    const doc = opts.library?.profile(ref.id, ref.version);
    if (doc === undefined) return fail("mind_profile_not_found", `${agentId}: no mind profile ${ref.id} version ${ref.version} in the library`, `${path}/profile`);
    const v = validateMindProfile(doc);
    if (!v.ok) return fail(v.error.code, `${agentId}: profile ${ref.id}: ${v.error.message}`, `${path}/profile`);
    profile = v.value.s2;
    profileRef = { id: ref.id, version: ref.version };
  } else {
    const v = validateMindProfile({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: entry.profile });
    if (!v.ok) return fail(v.error.code, `${agentId}: ${v.error.message}`, `${path}/profile${v.error.path === undefined ? "" : `/${v.error.path}`}`);
    profile = v.value.s2;
  }
  // The overrides are checked like the profile's own fields: a value out of range is refused with its path.
  const range = checkRanges(entry.overrides ?? {}, `${path}/overrides/`);
  if (range !== undefined) return fail(range.code, `${agentId}: ${range.message}`, range.path);
  const eff = resolveS2(profile, entry.overrides);
  const tdoc = opts.library?.template(eff.promptTemplate.id, eff.promptTemplate.version);
  if (tdoc === undefined) return fail("prompt_template_not_found", `${agentId}: no prompt template ${eff.promptTemplate.id} version ${eff.promptTemplate.version} in the library`, `${path}/profile`);
  const t = validatePromptTemplate(tdoc);
  if (!t.ok) return fail(t.error.code, `${agentId}: template ${eff.promptTemplate.id}: ${t.error.message}`, `${path}/profile`);
  const info = opts.providers?.(eff.provider);
  const host = info === undefined ? undefined : hostOf(info.baseUrl);
  if (info === undefined || host === undefined) return fail("provider_not_configured", `${agentId}: provider "${eff.provider}" is not configured in Settings`, `${path}/profile`);
  const { sources, ...effective } = eff;
  return ok({
    source,
    ...(profileRef === undefined ? {} : { profileRef }),
    effective,
    sources,
    template: { id: eff.promptTemplate.id, version: eff.promptTemplate.version, content: t.value },
    ...(entry.mission === undefined ? {} : { mission: entry.mission }),
    provider: { id: eff.provider, kind: info.kind, host },
  });
}
