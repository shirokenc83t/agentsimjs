import { validate } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { formatRunId, isValidTraceRecord, RunHeader, TraceRecord } from "./trace-record.ts";

describe("trace record v0", () => {
  const rec = { id: "r1", runId: "run-000001", seq: 0, simTime: 0, wallTime: 1, source: "world/sim", kind: "event", payload: { a: 1 } };

  it("accepts a minimal record and rejects unknown kinds", () => {
    expect(validate(TraceRecord, rec).ok).toBe(true);
    expect(validate(TraceRecord, { ...rec, kind: "telepathy" }).ok).toBe(false);
  });

  it("requires a valid source (ADR-0031): shape in the schema, vocabulary in isValidTraceRecord", () => {
    const { source: _s, ...noSource } = rec;
    expect(isValidTraceRecord(noSource)).toBe(false);
    expect(isValidTraceRecord({ ...rec, source: "uav-002/planner" })).toBe(true);
    expect(validate(TraceRecord, { ...rec, source: "uav-002/telepathy" }).ok).toBe(true); // shape only
    expect(isValidTraceRecord({ ...rec, source: "uav-002/telepathy" })).toBe(false);
    expect(isValidTraceRecord({ ...rec, source: "world/planner" })).toBe(false);
    expect(isValidTraceRecord({ ...rec, source: "uav-002" })).toBe(false);
  });

  it("formats deterministic run IDs", () => {
    expect(formatRunId(1)).toBe("run-000001");
    expect(formatRunId(42)).toBe("run-000042");
    expect(() => formatRunId(0)).toThrow(RangeError);
    expect(validate(RunHeader, { runId: formatRunId(7), schemaVersion: 0, createdAtWallMs: 1, label: "x", status: "running" }).ok).toBe(true);
  });
});
