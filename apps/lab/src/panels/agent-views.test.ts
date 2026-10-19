import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { actionLabel, actionState, agentViews, recoveryLabel } from "./agent-views.ts";

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

describe("the recovery of an agent, from its records (ADR-0041)", () => {
  const recovery = (payload: unknown, t: number) => rec("ugv-001", "action", { op: "recovery", reason: "inside_planning_clearance", ...(payload as object) }, t);

  it("a forward escape, a reverse, and what the last one was", () => {
    const escaped = agentViews([recovery({ kind: "escape", distanceM: 1.4, recoveries: 1 }, 3)]).get("ugv-001")?.recovery;
    expect(escaped).toEqual({ kind: "escape", reason: "inside_planning_clearance", distanceM: 1.4, atS: 3 });
    expect(recoveryLabel(escaped)).toBe("forward escape · inside_planning_clearance · 1.4 m");
    const reversed = agentViews([recovery({ kind: "escape", ok: false }, 3), recovery({ kind: "back-off", distanceM: 0.5 }, 3)]).get("ugv-001")?.recovery;
    expect(reversed?.kind).toBe("back-off");
    expect(recoveryLabel(reversed)).toBe("reverse · inside_planning_clearance · 0.5 m");
  });

  it("neither an escape nor a reverse found: the vehicle stays where it is", () => {
    const stay = agentViews([recovery({ kind: "escape", ok: false }, 4), recovery({ kind: "back-off", ok: false }, 4)]).get("ugv-001")?.recovery;
    expect(stay).toEqual({ kind: "stay", reason: "inside_planning_clearance", distanceM: 0, atS: 4 });
    expect(recoveryLabel(stay)).toBe("stay · inside_planning_clearance · neither an escape nor a reverse");
  });

  it("a reverse with no escape tried before it (a pre-drive back-off) is a reverse; an attempt that failed alone is not shown; none is none", () => {
    const predrive = agentViews([recovery({ kind: "back-off", reason: "predrive_failed", distanceM: 0.75 }, 5)]).get("ugv-001")?.recovery;
    expect(recoveryLabel(predrive)).toBe("reverse · predrive_failed · 0.8 m");
    expect(agentViews([recovery({ kind: "escape", ok: false }, 6)]).get("ugv-001")?.recovery).toBeUndefined();
    expect(recoveryLabel(undefined)).toBe("none");
  });

  it("the latest recovery wins over earlier ones", () => {
    const v = agentViews([recovery({ kind: "back-off", distanceM: 1 }, 1), recovery({ kind: "escape", distanceM: 2 }, 9)]).get("ugv-001")?.recovery;
    expect(v).toMatchObject({ kind: "escape", atS: 9 });
  });
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
