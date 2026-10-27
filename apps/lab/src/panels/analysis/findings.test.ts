import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import type { KnowledgeBand } from "../../shell/knowledge-band.ts";
import { findingsOf } from "./findings.ts";

const rec = (kind: TraceRecord["kind"], payload: unknown, simTime: number, agentId = "ugv-007"): TraceRecord => ({ id: `r#${simTime}`, runId: "r", seq: Math.round(simTime * 10), simTime, wallTime: 0, agentId, source: "x", kind, payload }) as TraceRecord;
const BAND: KnowledgeBand = { points: [{ t: 30, knownPct: 35.7, matchPct: 33.1, agents: 20 }], observed: 20, agentIds: [], ideal: 0, everyS: 10, gaps: [] };

describe("the findings line of the Analysis workspace", () => {
  it("says what the swarm knew at the end (observer data), the first reflex with its agent and time, and the failures", () => {
    const events = [rec("reflex", { reflex: "geofence", code: "geofence" }, 39.1), rec("reflex", { reflex: "battery", code: "battery_critical" }, 50, "ugv-002"), rec("action", { op: "end", status: "failed", failure: { code: "unreachable" } }, 12)];
    expect(findingsOf({ band: BAND, events, endS: 72.9 })).toEqual([
      "At the end the swarm knows 35.7 % of what it can reach, 33.1 % matching the truth (observer data, mean of 20 agents).",
      "2 reflexes: ugv-007 outside the geofence at 39.1 s (the first).",
      "1 action failed.",
    ]);
  });

  it("says the union when the band has it", () => {
    const withUnion = { ...BAND, union: { points: [{ t: 30, pct: 41.2 }], stepS: 10, calls: 20, costMs: 3 } };
    expect(findingsOf({ band: withUnion, events: [], endS: 40 })[0]).toBe("At the end the swarm knows 41.2 % of the map, 38.2 % of it matching the truth (observer data, the union of what its 20 agents know).");
  });

  it("leaves out a sentence the run holds nothing for", () => {
    expect(findingsOf({ band: { ...BAND, points: [] }, events: [], endS: 10 })).toEqual([]);
    expect(findingsOf({ band: BAND, events: [rec("reflex", { code: "obstacle_ahead" }, 3)], endS: 40 })).toEqual(["At the end the swarm knows 35.7 % of what it can reach, 33.1 % matching the truth (observer data, mean of 20 agents).", "One reflex: ugv-007 obstacle ahead at 3.0 s."]);
  });
});
