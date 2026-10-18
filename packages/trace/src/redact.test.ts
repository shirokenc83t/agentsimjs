import { describe, expect, it } from "vitest";
import { redactSecrets, REDACTED } from "./redact.ts";
import type { TraceRecord } from "./trace-record.ts";

// F3a M2: API keys are never recorded in any channel (CLAUDE.md, ADR-0035 §1 and addition item 5).

const KEY = "sk-ant-api03-PLANTED0123456789abcdefghijklmnop";
const rec = (payload: unknown): TraceRecord => ({ id: "run-000001#1", runId: "run-000001", seq: 1, simTime: 1, wallTime: 0, source: "uav-001/s1", kind: "thought", agentId: "uav-001", payload });

describe("redactSecrets", () => {
  it("replaces a value stored under a key that names a credential, at any depth", () => {
    const out = redactSecrets(rec({ op: "decision", params: { xM: 1, apiKey: KEY, nested: [{ Authorization: `Bearer ${KEY}` }, { api_key: "x" }, { password: "p" }, { secret: 1 }, { accessToken: "t" }] } }));
    const text = JSON.stringify(out);
    expect(text).not.toContain("PLANTED");
    expect(text).toContain(REDACTED);
    expect((out.payload as { params: { xM: number } }).params.xM).toBe(1);
  });

  it("replaces a key-shaped string wherever it appears: in a text, an array, under any key", () => {
    const out = redactSecrets(rec({ op: "request", self: { note: `use ${KEY} for the call` }, list: [KEY, "fine"], other: { text: "sk-short" } }));
    const text = JSON.stringify(out);
    expect(text).not.toContain("PLANTED");
    expect(text).toContain("sk-short"); // too short to be a key
    expect(text).toContain("fine");
  });

  it("leaves a record without secrets as it is (the same object) and never changes the input", () => {
    const clean = rec({ op: "request", tick: 3, self: { x: 1 }, tokens: 12, keyframe: true });
    expect(redactSecrets(clean)).toBe(clean); // `tokens` and `keyframe` are not credentials
    const dirty = rec({ apiKey: KEY });
    const before = JSON.stringify(dirty);
    redactSecrets(dirty);
    expect(JSON.stringify(dirty)).toBe(before);
  });

  it("handles payloads that are not objects, and deep or wide payloads", () => {
    expect(redactSecrets(rec(null)).payload).toBeNull();
    expect(redactSecrets(rec("text")).payload).toBe("text");
    expect(JSON.stringify(redactSecrets(rec(`key ${KEY}`)).payload)).not.toContain("PLANTED");
    let deep: unknown = { apiKey: KEY };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(JSON.stringify(redactSecrets(rec(deep)))).not.toContain("PLANTED");
  });
});
