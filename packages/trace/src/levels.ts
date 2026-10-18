import { contentHash64 } from "@agentsim/core";
import { channelOf } from "./channels.ts";
import type { RecordingProfile } from "./recording-profile.ts";
import type { TraceRecord } from "./trace-record.ts";

// Level filters (ADR-0035 §1, addition of 2026-10-17, items 1 and 2): pure functions from a record to the record a profile keeps
// of it. A profile changes the detail of a record, never whether it exists; the only records a profile may drop are those of a
// channel the tracing rule does not cover (the observer's `beliefs` samples, `sensors`). Pose, metric and health samples are
// sampled by their producers at the profile's rate; this module does not thin them.

const payloadOf = (r: TraceRecord): Record<string, unknown> | undefined => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : undefined);

/**
 * `compute: summary`: a strategy query's record without the `waypoints` of each of its searches (ADR-0037 item 14); the branch,
 * the condition values and the per-search charge stay, and so does the query's own result. Still one record per query. The
 * record of a plain query is returned as it is.
 */
export function summarizeCompute(r: TraceRecord): TraceRecord {
  const p = payloadOf(r);
  const strategy = p?.strategy as { searches?: unknown } | undefined;
  if (!p || !strategy || !Array.isArray(strategy.searches) || !strategy.searches.some((s) => s !== null && typeof s === "object" && "waypoints" in s)) return r;
  const searches = strategy.searches.map((s) => {
    if (s === null || typeof s !== "object" || !("waypoints" in s)) return s;
    const { waypoints: _dropped, ...rest } = s as Record<string, unknown>;
    return rest;
  });
  return { ...r, payload: { ...p, strategy: { ...strategy, searches } } };
}

/**
 * `mind-io: metadata`: a request keeps `tick`, `events`, `eventsDropped`, `unavailable`, `allowed` and `space` (every
 * reference), and its `self` and `beliefs` bodies become their content hash (64-bit, of the body's JSON text). Space summaries
 * and every other record are returned as they are.
 */
export function metadataMindIo(r: TraceRecord): TraceRecord {
  const p = payloadOf(r);
  if (!p || p.op !== "request") return r;
  const out: Record<string, unknown> = { ...p };
  for (const key of ["self", "beliefs"] as const) if (key in p && p[key] !== undefined) out[key] = contentHash64(JSON.stringify(p[key]));
  return { ...r, payload: out };
}

/** Whether the profile drops the record: `beliefs: off` drops the observer's samples, `sensors: off` any sensor-channel record. */
export function dropsRecord(profile: RecordingProfile, r: Pick<TraceRecord, "kind" | "source" | "payload">): boolean {
  const channel = channelOf(r);
  if (channel === "beliefs") return profile.channels.beliefs.level === "off";
  if (channel === "sensors") return profile.channels.sensors.level === "off";
  return false;
}

/**
 * What the profile keeps of a record: undefined when it drops it, the record with its detail lowered, or the record as it is.
 * A record the channel table does not map is kept as it is: a gap in the table never loses a record (a test fails on it instead).
 */
export function filterRecord(profile: RecordingProfile, r: TraceRecord): TraceRecord | undefined {
  const channel = channelOf(r);
  if (channel === undefined) return r;
  if (dropsRecord(profile, r)) return undefined;
  if (channel === "compute" && profile.channels.compute.level === "summary") return summarizeCompute(r);
  if (channel === "mind-io" && profile.channels["mind-io"].level === "metadata") return metadataMindIo(r);
  return r;
}
