import { isValid } from "@agentsim/core";
import Type, { type Static } from "typebox";
import { isValidSource, SOURCE_MAX_LENGTH, SOURCE_PATTERN } from "./source.ts";

/**
 * Trace record v0 (ADR-0004, ROADMAP appendix). F0 needs it only as the storage payload shape;
 * F3 owns the full schema (levels of detail, snapshots, versioned evolution).
 */
export const TRACE_SCHEMA_VERSION = 0;

/** The closed list of record kinds (ADR-0004); UI tags and colours are generated from it (ADR-0032 §5). */
export const TRACE_KINDS = [
  "event", "thought", "action", "observation", "message", "escalation", "reflex", "detector",
  "injected", "snapshot", "compute", "plan", "plan-node", "policy", "policy-rule", "group",
  "lifecycle", "protocol", "contract", "degradation",
] as const;

export const TraceKind = Type.Enum([...TRACE_KINDS]);
export type TraceKind = Static<typeof TraceKind>;

export const Tier = Type.Union([Type.Literal("S1"), Type.Literal("S2"), Type.Literal("external")]);

export const TraceRecord = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  runId: Type.String({ minLength: 1, maxLength: 64 }),
  seq: Type.Integer({ minimum: 0 }),
  parentId: Type.Optional(Type.String({ maxLength: 64 })),
  causeIds: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 })),
  /** Simulation time in seconds. */
  simTime: Type.Number({ minimum: 0 }),
  /** Wall-clock time in milliseconds since the Unix epoch (informational; never drives the sim). */
  wallTime: Type.Number({ minimum: 0 }),
  /** Subject of the record: the agent or group it is about. */
  agentId: Type.Optional(Type.String({ maxLength: 64 })),
  groupId: Type.Optional(Type.String({ maxLength: 64 })),
  /**
   * Emitter `<owner>/<component>` (ADR-0031), set by the simulator through tracer handles, never by minds.
   * The schema checks the shape; `isValidTraceRecord` also checks the per-owner component vocabulary.
   */
  source: Type.String({ pattern: SOURCE_PATTERN, maxLength: SOURCE_MAX_LENGTH }),
  kind: TraceKind,
  tier: Type.Optional(Tier),
  detail: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("transitions"), Type.Literal("sampled")])),
  payload: Type.Unknown(),
  beliefRef: Type.Optional(Type.String({ maxLength: 64 })),
  worldRef: Type.Optional(Type.String({ maxLength: 64 })),
});
export type TraceRecord = Static<typeof TraceRecord>;

/**
 * Run invariant (ADR-0031 amendment): within a run, records ordered by `seq` have non-decreasing
 * `simTime`, so a time window maps to a `seq` range. Importers (database, JSONL) reject runs that
 * violate it. Returns the first offending record, or undefined.
 */
export function firstNonMonotonicRecord(records: readonly Pick<TraceRecord, "runId" | "seq" | "simTime">[]): Pick<TraceRecord, "runId" | "seq" | "simTime"> | undefined {
  const sorted = [...records].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : a.seq - b.seq));
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1];
    const b = sorted[k];
    if (a && b && a.runId === b.runId && b.simTime < a.simTime) return b;
  }
  return undefined;
}

/** Full check of an untrusted record: schema plus the source vocabulary (ADR-0031). */
export function isValidTraceRecord(r: unknown): r is TraceRecord {
  return isValid(TraceRecord, r) && isValidSource(r.source);
}

export const RunStatus = Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("aborted")]);
export type RunStatus = Static<typeof RunStatus>;

export const RunHeader = Type.Object({
  runId: Type.String({ pattern: "^run-[0-9]{6}$" }),
  schemaVersion: Type.Integer({ minimum: 0 }),
  /** Wall-clock creation time, ms since epoch (metadata only). */
  createdAtWallMs: Type.Number({ minimum: 0 }),
  label: Type.String({ maxLength: 200 }),
  scenario: Type.Optional(Type.String({ maxLength: 200 })),
  seed: Type.Optional(Type.Integer()),
  status: RunStatus,
  // Reproducibility (ADR-0028). Optional only for runs without a scenario (F0 sample runs); a simulated run
  // records all of them. `scenarioVersion` is required whenever `scenarioId` is set (checked by the stores).
  scenarioId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" })),
  scenarioVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  /** The run's own copy of its run configuration document. */
  runConfig: Type.Optional(Type.Unknown()),
  runConfigHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{8}$" })),
  effectiveConfigHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{8}$" })),
  /** Package version and git commit of the simulator that produced the run. */
  simulatorVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  /** Agents whose beliefs were `ideal` (ground truth), as resolved at run start; sorted (ADR-0028 addition of 2026-10-10). */
  idealAgents: Type.Optional(Type.Array(Type.String({ pattern: "^(uav|ugv|ev|virt)-[0-9]+$", maxLength: 32 }), { maxItems: 4096 })),
});
export type RunHeader = Static<typeof RunHeader>;

/** Run IDs are per-database counters, never random (ADR-0015 spirit, ADR-0002). */
export function formatRunId(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999) throw new RangeError(`run counter out of range: ${n}`);
  return `run-${String(n).padStart(6, "0")}`;
}
