import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { actionLabel, actionState, agentViews } from "./agent-views.ts";

let seq = 0;
const rec = (agentId: string, kind: TraceRecord["kind"], payload: unknown, simTime = 0): TraceRecord => ({
  id: `run-000001#${seq}`,
  runId: "run-000001",
  seq: seq++,
  simTime,
  wallTime: 0,
  agentId,
  source: `${agentId}/actions`,
  kind,
  payload,
});

describe("agent views from trace records", () => {
  it("the latest researcher command shows as accepted or refused with its code", () => {
    const inj = (payload: unknown, t: number) => ({ ...rec("uav-001", "injected", payload, t), source: "world/sim" });
    const v = agentViews([
      inj({ op: "command", name: "goTo", ok: false, failure: "precondition_failed" }, 1),
      inj({ op: "command", name: "takeoff", ok: true, actionId: "act-000001" }, 2),
    ]).get("uav-001");
    expect(v?.command).toEqual({ name: "takeoff", ok: true, failure: undefined, atS: 2 });
    const refused = agentViews([inj({ op: "command", name: "goTo", ok: false, failure: "precondition_failed" }, 1)]).get("uav-001");
    expect(refused?.command).toEqual({ name: "goTo", ok: false, failure: "precondition_failed", atS: 1 });
  });

  it("follows an action from start through phases to its end, with the failure code", () => {
    const v = agentViews([
      rec("ugv-001", "action", { op: "start", actionId: "act-000001", name: "goTo" }),
      rec("ugv-001", "action", { op: "phase", actionId: "act-000001", from: "planning", to: "following" }),
    ]).get("ugv-001");
    expect(actionLabel(v?.action)).toBe("goTo · following");
    expect(actionState(v?.action)).toBe("run");
    const done = agentViews([
      rec("ugv-001", "action", { op: "start", actionId: "act-000002", name: "goTo" }),
      rec("ugv-001", "action", { op: "end", actionId: "act-000002", name: "goTo", status: "failed", failure: { code: "unreachable" } }),
    ]).get("ugv-001");
    expect(actionLabel(done?.action)).toBe("goTo · failed · unreachable");
    expect(actionState(done?.action)).toBe("alm");
    expect(actionLabel(undefined)).toBe("idle");
  });

  it("keeps the latest found plan with its length, and the latest reflex", () => {
    const v = agentViews([
      rec("ugv-002", "compute", { op: "plan", status: "found", algorithm: "astar", expansionsCharged: 900, completedTick: 3, waypoints: [[0, 0], [3, 4]] }),
      rec("ugv-002", "compute", { op: "plan", status: "not_found", algorithm: "astar", waypoints: [] }),
      rec("ugv-002", "reflex", { reflex: "battery", code: "battery_critical", then: "returnToBase" }, 2.5),
    ]).get("ugv-002");
    expect(v?.plan).toMatchObject({ algorithm: "astar", expansionsCharged: 900, completedTick: 3, lengthM: 5 });
    expect(v?.reflex).toEqual({ reflex: "battery", code: "battery_critical", then: "returnToBase", atS: 2.5 });
  });
});
