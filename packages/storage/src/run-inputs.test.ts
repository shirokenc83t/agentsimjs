import { describe, expect, it } from "vitest";
import { checkRunInputs } from "./run-inputs.ts";

// Run inputs are stored as `{ inputId, tick, agentId, name, params }`: what a run ran (ADR-0015 clarification of
// 2026-10-04), independent of the worker message that created them. These literals are the F1 stored form, written
// out so that a change to the message or to the stored shape cannot silently change what old runs contain.
const F1_STORED = [
  { inputId: "inp-000001", tick: 1, agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } },
  { inputId: "inp-000002", tick: 101, agentId: "ugv-002", name: "goTo", params: { xM: 25, yM: 30 } },
];

describe("stored run inputs", () => {
  it("accepts the F1 stored form unchanged", () => {
    const r = checkRunInputs([], F1_STORED);
    expect(r.ok && r.value).toEqual(F1_STORED);
  });

  it("is not the worker's command message: the flat F1 message and the M2e message shape are refused as stored inputs", () => {
    expect(checkRunInputs([], [{ type: "command", op: "goTo", agentId: "ugv-001", xM: 50, yM: 10 }]).ok).toBe(false);
    expect(checkRunInputs([], [{ type: "command", op: "goTo", agentId: "ugv-001", params: { xM: 50, yM: 10 } }]).ok).toBe(false);
  });
});
