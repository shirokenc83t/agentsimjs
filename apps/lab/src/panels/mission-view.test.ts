import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { missionBadge, missionLine, missionPoints, missionViewOf, missionViews } from "./mission-view.ts";

// The progress of a mission, derived from the run's trace records alone (F3c M1): the steps from the config record, each step's state from the decision that began it, the action it
// started and how that ended; a stop with its step, cause and the rule after a preemption.

let seq = 0;
const rec = (kind: TraceRecord["kind"], payload: unknown, simTime: number, extra: Partial<TraceRecord> = {}): TraceRecord => ({
  id: `run-000001#${seq}`,
  runId: "run-000001",
  seq: seq++,
  simTime,
  wallTime: 0,
  agentId: "uav-001",
  source: "uav-001/x",
  kind,
  payload,
  ...extra,
});
const STEPS = [{ action: "takeoff", args: { altitudeM: 20 } }, { action: "goTo", args: { xM: 50, yM: 20 } }, { action: "explore", args: { radiusM: 20 } }, { action: "returnToBase" }];
const config = () => rec("lifecycle", { op: "config", mind: { s1: { script: { name: "sequence", params: { steps: STEPS } } } } }, 0);
const decision = (step: number, t: number, more: object = {}) => rec("thought", { op: "decision", step, of: STEPS.length, ...more }, t);
const start = (id: string, name: string, t: number, cause: string) => rec("action", { op: "start", actionId: id, name }, t, { causeIds: [cause] });
const end = (id: string, status: string, t: number, failure?: string) => rec("action", { op: "end", actionId: id, status, ...(failure ? { failure: { code: failure } } : {}) }, t);

/** Takes off (0 to 4 s) and goes to the point (4 s on, still running). */
function running(): TraceRecord[] {
  const d1 = decision(1, 0);
  const s1 = start("a1", "takeoff", 0, d1.id);
  const e1 = end("a1", "succeeded", 4);
  const d2 = decision(2, 4);
  const s2 = start("a2", "goTo", 4, d2.id);
  return [config(), d1, s1, e1, d2, s2];
}

describe("the progress of a mission", () => {
  it("is nothing for an agent with no mission", () => {
    expect(missionViewOf([rec("lifecycle", { op: "config" }, 0)], "uav-001")).toBeUndefined();
    expect(missionViewOf([], "uav-001")).toBeUndefined();
  });

  it("is ready before the first decision: every step pending", () => {
    const v = missionViewOf([config()], "uav-001");
    expect(v?.status).toBe("ready");
    expect(v?.steps.map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(v?.current).toBe(0);
  });

  it("shows the finished steps done with their durations, the one in progress running with its phase, and the rest pending", () => {
    const records = [...running(), rec("action", { op: "phase", actionId: "a2", to: "following" }, 5)];
    const v = missionViewOf(records, "uav-001");
    expect(v?.status).toBe("running");
    expect(v?.current).toBe(2);
    expect(v?.steps.map((s) => s.state)).toEqual(["done", "running", "pending", "pending"]);
    expect(v?.steps[0]).toMatchObject({ action: "takeoff", startedAtS: 0, endedAtS: 4, durationS: 4 });
    expect(v?.steps[1]).toMatchObject({ action: "goTo", detail: "following", startedAtS: 4 });
    expect(missionLine(v, "uav-001")).toBe("uav-001 mission 2 / 4 · goTo");
    expect(missionBadge(v)).toBe("▶ 2/4");
  });

  it("holds each step's decision record, so a click on the step can select it", () => {
    const records = running();
    const v = missionViewOf(records, "uav-001");
    expect(v?.steps[1]?.decisionId).toBe(records[4]?.id);
    expect(v?.steps[1]?.decisionSeq).toBe(records[4]?.seq);
    expect(v?.steps[2]?.decisionId).toBeUndefined();
  });

  it("ends done when the last step's completion is decided: every step ✓, the mission done", () => {
    const records = running();
    records.push(end("a2", "succeeded", 20));
    let t = 20;
    for (const [i, name] of [[3, "explore"], [4, "returnToBase"]] as const) {
      const d = decision(i, t);
      records.push(d, start(`a${i}`, name, t, d.id), end(`a${i}`, "succeeded", t + 10));
      t += 10;
    }
    records.push(decision(4, t, { done: true }));
    const v = missionViewOf(records, "uav-001");
    expect(v?.status).toBe("done");
    expect(v?.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(missionLine(v, "uav-001")).toBe("uav-001 mission 4 / 4 · done");
    expect(missionBadge(v)).toBe("✓ 4/4");
  });

  it("stops at a refused step: the step ✕ with the code, the later ones not run, and a line in words", () => {
    const d1 = decision(1, 0);
    const rejected = rec("action", { op: "rejected", name: "takeoff", failure: "precondition_failed" }, 0, { causeIds: [d1.id] });
    const stop = decision(1, 0.1, { stop: { status: "refused", action: "takeoff", code: "precondition_failed" } });
    const v = missionViewOf([config(), d1, rejected, stop], "uav-001");
    expect(v?.status).toBe("stopped");
    expect(v?.steps.map((s) => s.state)).toEqual(["refused", "skipped", "skipped", "skipped"]);
    expect(v?.steps[0]?.detail).toBe("precondition_failed");
    expect(v?.stop?.line).toBe("Mission stopped at step 1 of 4 · takeoff refused: precondition_failed · steps 2–4 not run");
    expect(missionBadge(v)).toBe("■ 1/4");
  });

  it("stops at a preempted step with the reflex that took the agent over, and says the action does not resume", () => {
    const records = running();
    records.push(rec("reflex", { reflex: "battery", code: "battery_critical", then: "returnToBase" }, 38), end("a2", "preempted", 38, "preempted"));
    records.push(decision(2, 38.1, { stop: { status: "preempted", action: "goTo", code: "preempted" } }));
    const v = missionViewOf(records, "uav-001");
    expect(v?.steps.map((s) => s.state)).toEqual(["done", "preempted", "skipped", "skipped"]);
    expect(v?.steps[1]?.endedAtS).toBe(38);
    expect(v?.stop?.line).toBe("Mission stopped at step 2 of 4 · goTo preempted at 38.0 s by battery critical · goTo does not resume after a preemption · steps 3–4 not run");
  });

  it("stops at a failed step with its failure code; the last step has no later steps to name", () => {
    const records = running();
    records.push(end("a2", "failed", 9, "unreachable"), decision(2, 9.1, { stop: { status: "failed", action: "goTo", code: "unreachable" } }));
    const v = missionViewOf(records, "uav-001");
    expect(v?.steps[1]).toMatchObject({ state: "failed", detail: "unreachable" });
    expect(v?.stop?.line).toBe("Mission stopped at step 2 of 4 · goTo failed at 9.0 s: unreachable · steps 3–4 not run");
  });

  it("keeps the agents apart", () => {
    const other = rec("lifecycle", { op: "config", mind: { s1: { script: { name: "sequence", params: { steps: [{ action: "hold" }] } } } } }, 0, { agentId: "uav-002" });
    expect(missionViewOf([config(), other], "uav-002")?.steps.map((s) => s.action)).toEqual(["hold"]);
    expect(missionViewOf([config(), other], "uav-001")?.steps).toHaveLength(4);
  });

  it("finds the agents that have a mission in one pass, and draws the rest of it from the agent through the points still to go to", () => {
    const records = running();
    expect([...missionViews(records).keys()]).toEqual(["uav-001"]);
    const v = missionViewOf(records, "uav-001");
    // goTo (50, 20) is the running step: the agent is at (10, 10).
    expect([...(missionPoints(v, { x: 10, y: 10 }) ?? [])]).toEqual([10, 10, 50, 20]);
    expect(missionPoints(v, undefined)).toBeUndefined();
    expect(missionPoints(missionViewOf([config()], "uav-001"), { x: 0, y: 0 })).toBeDefined();
    const stopped = missionViewOf([...records, decision(2, 9, { stop: { status: "failed", action: "goTo", code: "unreachable" } })], "uav-001");
    expect(missionPoints(stopped, { x: 10, y: 10 })).toBeUndefined();
  });
});
