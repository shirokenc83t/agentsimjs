import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { resultOf, summary } from "./log-rows.ts";

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
});
