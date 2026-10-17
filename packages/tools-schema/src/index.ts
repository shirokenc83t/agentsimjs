export {
  VEHICLE_KINDS,
  type VehicleKind,
  type Scope,
  type CapabilityKind,
  type CapabilityDef,
  type PreconditionRef,
  type PreconditionName,
} from "./capability.ts";
export { goTo, explore, hold, returnToBase, takeoff, land } from "./actions/base-actions.ts";
export { setTimer, cancelTimer, TIMER_LIMITS } from "./actions/bookkeeping.ts";
export {
  CAPABILITIES,
  COMMON_FAILURE_CODES,
  PRECONDITIONS,
  getCapability,
  INJECTABLE_COMMANDS,
  isInjectable,
  validateParams,
  type BaseActionName,
  type ActionParams,
  type ActionResult,
  type CommonFailureCode,
  type InjectableCommand,
  type ParamsError,
} from "./registry.ts";
export {
  capabilityManifest,
  MANIFEST_SCHEMA_VERSION,
  type CapabilityManifest,
  type CapabilityManifestEntry,
  type JsonSchema,
} from "./exposures/manifest.ts";
