export {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_LIMITS,
  ScenarioDocument,
  ScenarioId,
  AgentKey,
  WorldSpec,
  ZoneSpec,
  AgentSpec,
  ObjectSpec,
  PriorSpec,
  UavBody,
  UgvBody,
  type LayerKey,
} from "./schema.ts";
export {
  parseScenario,
  parseScenarioValue,
  validateScenario,
  zonePolygon,
  isSimplePolygon,
  utf8Length,
  type ScenarioError,
  type ScenarioErrorCode,
} from "./validate.ts";
export { decodePrior, loadScenario, scenarioAgents, formatAgentId, type LoadedScenario, type LoadedAgent, type ScenarioAgentsView } from "./load.ts";
export { encodeLayer, encodePriorKnowledge, scenarioFromGrid, serializeScenario, type ScenarioMeta } from "./encode.ts";
export { canonicalJson, hash32Hex } from "./canonical.ts";
export {
  BUILTIN_BODY_DEFAULTS,
  resolveBody,
  type BodyDefaults,
  type ResolvedUavBody,
  type ResolvedUgvBody,
} from "./body-defaults.ts";
export {
  RUN_CONFIG_SCHEMA_VERSION,
  RUN_CONFIG_MAX_BYTES,
  RunConfigDocument,
  PlanningEntry,
  BeliefsEntry,
  DriveEntry,
  AlgorithmSpec,
} from "./run-config/schema.ts";
export {
  parseRunConfig,
  parseRunConfigValue,
  resolveRunConfig,
  canonicalRunConfig,
  effectiveConfigHash,
  withRuntimeChange,
  agentWarnings,
  resolveStrategySpec,
  toPlanningConfig,
  toPlanningAlgorithm,
  type ResolvedRunConfig,
  type ResolvedStrategy,
  type RunConfigWarning,
  type EffectiveAgentConfig,
  type ConfigLevel,
  type PlanningField,
  type ResolveOptions,
  type RunConfigError,
  type RunConfigErrorCode,
} from "./run-config/resolve.ts";
export { traversalFor } from "./traversal.ts";
export { estimatedTrackingCutM, ugvBodyWarnings, type BodyWarning, type BodyWarningCode } from "./body-warnings.ts";
export * from "./assemble/index.ts";
export { F1_DEMO_ID, f1DemoScenario, f1DemoRunConfig } from "./presets/f1-demo.ts";
export { F2_DISCOVERY_ID, F2_PRIOR_REFERENCE_ID, F2_TWENTY_AGENTS_ID, f2DiscoveryScenario, f2PriorReferenceScenario, f2PriorRunConfig, f2RunConfig, f2TwentyAgentsScenario } from "./presets/f2-presets.ts";
export { F1_REFERENCE_WORLD_ID, f1ReferenceWorldScenario, f1ReferenceWorldRunConfig } from "./presets/f1-reference-world.ts";
/** Cost profiles are part of run configurations (ADR-0028): re-exported so editors validate them with the same compiler. */
export { CostProfile, compileCostProfile, F1_FEATURES, type CostProfileErrorCode, type Feature } from "@agentsim/algorithms";
/** Shipped planning strategies (ADR-0037): the run-configuration panel lists them without a direct dependency on the algorithms package. */
export { PLANNING_STRATEGY_PRESETS, type PlanningStrategy, type StrategyRef } from "@agentsim/algorithms";
