export {
  ActionRuntime,
  type ActionInfo,
  type EndedAction,
  type ActionStatus,
  type ActionFailure,
  type Caller,
  type RuntimePorts,
  type RuntimeSnapshot,
  type BehaviorSnapshot,
  type HoldSnapshot,
  type TakeoffSnapshot,
  type LandSnapshot,
  type GoToSnapshot,
  type ExploreSnapshot,
} from "./runtime.ts";
export { agentPosition, hashAgent, type SimAgent, type UgvBodyParams, type UavBodyParams } from "./agent.ts";
export type { PlannerPort, PlanQuery, PlanResult, PlanLeg, PlanProgress, PlanMap, KnownSpace, FrontierPort, FrontierCandidate, SpatialPort, CapabilityPort, TraceSink, Scope, ProximityPort, ContactPort } from "./ports.ts";
export { predictTracking, type PredriveOutcome } from "./predrive.ts";
export { vehicleAvailability, stateAvailability, commandAvailability, preconditionHolds, describeUnavailable, type AgentFacts, type Unavailable } from "./availability.ts";
