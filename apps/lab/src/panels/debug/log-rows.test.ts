import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { resultOf, summary, tagOf } from "./log-rows.ts";

const rec = (kind: string, payload: unknown, detail?: string) => ({ seq: 1, simTime: 1, kind, payload, ...(detail ? { detail } : {}) }) as unknown as TraceRecord;

describe("log rows", () => {
  it("an action that ends says how, with a glyph; a failure carries its code and is what tints the row", () => {
    expect(resultOf(rec("action", { op: "end", status: "succeeded" }))).toEqual({ text: "✓ succeeded", failed: false });
    expect(resultOf(rec("action", { op: "end", status: "preempted" }))).toEqual({ text: "○ preempted", failed: false });
    expect(resultOf(rec("action", { op: "end", status: "failed", failure: { code: "unreachable" } }))).toEqual({ text: "✕ failed · unreachable", failed: true });
    expect(resultOf(rec("action", { op: "end", status: "failed" }))).toEqual({ text: "✕ failed", failed: true });
  });

  it("nothing else has a result: a start, another kind, a payload without a status", () => {
    expect(resultOf(rec("action", { op: "start", name: "goTo" }))).toBeUndefined();
    expect(resultOf(rec("reflex", { op: "end", status: "failed" }))).toBeUndefined();
    expect(resultOf(rec("action", null))).toBeUndefined();
  });

  it("the summary joins the op, the name and the detail", () => {
    expect(summary(rec("action", { op: "start", name: "goTo" }, "to (3, 4)"))).toBe("start · goTo · to (3, 4)");
    expect(summary(rec("event", null))).toBe("");
  });

  it("a mission's decision says its step: the action begun, the end, the stop; a decision without a mission keeps its detail", () => {
    expect(summary(rec("thought", { op: "decision", step: 2, of: 4, decision: { kind: "action", name: "goTo" } }, "full"))).toBe("decision · step 2 of 4 · goTo");
    expect(summary(rec("thought", { op: "decision", step: 4, of: 4, done: true, decision: { kind: "idle" } }, "full"))).toBe("decision · step 4 of 4 · done");
    expect(summary(rec("thought", { op: "decision", step: 2, of: 4, stop: { status: "failed" }, decision: { kind: "idle" } }, "full"))).toBe("decision · step 2 of 4 · stopped");
    expect(summary(rec("thought", { op: "decision" }, "full"))).toBe("decision · full");
  });
});

describe("the summary lines of a System 2 mind's records (F4 M4, T-123)", () => {
  const rec = (kind: string, payload: Record<string, unknown>) => ({ id: "run-000001#1", runId: "run-000001", seq: 1, simTime: 1, wallTime: 1, source: "uav-001/s2", kind, payload }) as never;
  it("says what a model call, a compute call, a limit record, a fallback and a miss of the cache were", () => {
    expect(summary(rec("thought", { op: "llm-call", attempt: 1, usage: { inputTokens: 2702, outputTokens: 61 }, latencyMs: 1900, outcome: "ok", response: { toolCalls: [{}, {}] }, cacheHit: true }))).toBe("llm-call · attempt 1 · 2 702 → 61 tok · 1.9 s · asks 2 tools · cache");
    expect(summary(rec("thought", { op: "llm-call", attempt: 2, outcome: "invalid" }))).toBe("llm-call · attempt 2 · invalid");
    expect(summary(rec("compute", { op: "tool", tool: "planPath", ok: true, status: "found", expansions: 212 }))).toBe("tool · planPath · found · 212 exp");
    expect(summary(rec("compute", { op: "tool", tool: "planPath", ok: false, code: "tool_call_limit" }))).toBe("tool · planPath · tool_call_limit");
    expect(summary(rec("thought", { op: "limit-warning", limit: "tokens", pct: 82, used: 32818, max: 40000 }))).toBe("limit-warning · tokens 82 % (32 818 of 40 000)");
    expect(summary(rec("thought", { op: "limit-hit", limit: "calls", used: 20, max: 20 }))).toBe("limit-hit · calls 20 of 20");
    expect(summary(rec("lifecycle", { op: "raiseLimit", limit: "tokens", before: 40000, after: 80000 }))).toBe("raiseLimit · tokens 40 000 → 80 000");
    expect(summary(rec("thought", { op: "fallback", decision: "hold", reason: "no answer in 60 s" }))).toBe("fallback · hold · no answer in 60 s");
    expect(summary(rec("thought", { op: "cache-miss", attempt: 1 }))).toBe("cache-miss · attempt 1");
    expect(summary(rec("thought", { op: "not-reproducible", fromTick: 41 }))).toBe("not-reproducible · from tick 41");
  });
});

describe("the task records and the decisions of a mind under the wake policy `task` (F4b M2, U-024)", () => {
  it("the task records are TSK in the run family; every other record keeps the tag of its kind", () => {
    expect(tagOf(rec("event", { op: "task", steps: [] }), { family: "slate", tag: "EVT" })).toEqual({ tag: "TSK", family: "cyan" });
    expect(tagOf(rec("event", { op: "task_step", step: 1 }), { family: "slate", tag: "EVT" })).toEqual({ tag: "TSK", family: "cyan" });
    expect(tagOf(rec("event", { op: "event" }), { family: "slate", tag: "EVT" })).toEqual({ tag: "EVT", family: "slate" });
    expect(tagOf(rec("thought", { op: "task" }), { family: "violet", tag: "THK" })).toEqual({ tag: "THK", family: "violet" });
    expect(tagOf(rec("mystery", {}), undefined)).toEqual({ tag: "MYS", family: "slate" });
  });

  it("writes the list as written and each step as the world marks it, with the glyph of the mission view", () => {
    expect(summary(rec("event", { op: "task", steps: [{ text: "a" }, { text: "b" }, { text: "c" }] }))).toBe("list written · 3 steps");
    expect(summary(rec("event", { op: "task_step", step: 1, of: 5, status: "running" }))).toBe("step 1 of 5 ▶ running");
    expect(summary(rec("event", { op: "task_step", step: 2, of: 5, status: "done" }))).toBe("step 2 of 5 ✓ done");
    expect(summary(rec("event", { op: "task_step", step: 3, of: 5, status: "failed", outcome: "preempted", code: "preempted" }))).toBe("step 3 of 5 ▲ preempted");
    expect(summary(rec("event", { op: "task_step", step: 3, of: 5, status: "failed", outcome: "failed", code: "no_path" }))).toBe("step 3 of 5 ✕ failed · no_path");
    expect(summary(rec("event", { op: "task_step", step: 4, of: 5, status: "failed", outcome: "refused", code: "precondition_failed" }))).toBe("step 4 of 5 ✕ refused · precondition_failed");
  });

  it("a decision ends its line with how many perception events it held back, and says it went on with the running action, in plain words", () => {
    expect(summary(rec("thought", { op: "decision", decision: { kind: "idle" }, step: 2, of: 5, held: 3 }))).toBe("decision · step 2 of 5 · held 3");
    expect(summary(rec("thought", { op: "decision", decision: { kind: "action", name: "goTo" }, held: 2 }))).toBe("decision · held 2");
    expect(summary(rec("thought", { op: "decision", decision: { kind: "idle" }, continued: true, actionId: "act-000002", events: [{ kind: "timer" }, { kind: "detected" }, { kind: "timer" }], held: 1 }))).toBe("decision · ↻ continued act-000002 · timer, detected · held 1");
    // Nothing held: nothing said, and a decision of F4 reads as it did.
    expect(summary(rec("thought", { op: "decision", decision: { kind: "idle" } }))).toBe("decision");
    expect(summary(rec("thought", { op: "decision", decision: { kind: "idle" }, held: 0 }))).toBe("decision");
  });
});
