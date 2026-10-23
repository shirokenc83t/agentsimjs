import { describe, expect, it } from "vitest";
import { matchesRecord, matchesSample, parseFilter, type FilterAst } from "./filter.ts";
import type { TraceRecord } from "./trace-record.ts";

// The filter language (UI-SPEC section 5.2, ADR-0035 section 5): one parser and AST; the predicate is the live backend.

const ast = (text: string): FilterAst => {
  const r = parseFilter(text);
  if (!r.ok) throw new Error(`${text}: ${r.error.message}`);
  return r.value;
};
const rejects = (text: string): string => {
  const r = parseFilter(text);
  if (r.ok) throw new Error(`accepted: ${text}`);
  return r.error.message;
};

const rec = (over: Partial<TraceRecord> = {}): TraceRecord => ({ id: "run-000001#10", runId: "run-000001", seq: 10, simTime: 150, wallTime: 1, source: "uav-002/planner", kind: "thought", agentId: "uav-002", payload: { op: "decision", note: "Battery LOW" }, ...over });

describe("parseFilter", () => {
  it("parses the terms of the specification: AND of terms, OR inside a term, negation", () => {
    const a = ast('agent:uav-002,ugv-001 kind:thought,action tier:S1 t:120..300 text:"battery low" cause:#4812 parent:#4800 detector:late-decision status:failed -kind:snapshot source:uav-002/planner,*/reflexes');
    expect(a.target).toBe("records");
    expect(a.terms.map((t) => `${t.negated ? "-" : ""}${t.key}`)).toEqual(["agent", "kind", "tier", "t", "text", "cause", "parent", "detector", "status", "-kind", "source"]);
    expect(a.terms[0]).toMatchObject({ values: ["uav-002", "ugv-001"] });
    expect(a.terms[4]).toMatchObject({ text: "battery low" });
    expect(a.terms[5]).toMatchObject({ seqs: [4812] });
    expect(a.terms[10]).toMatchObject({ patterns: [{ owner: "uav-002", component: "planner" }, { owner: null, component: "reflexes" }] });
  });

  it("an empty filter is valid and selects everything", () => {
    expect(ast("")).toEqual({ target: "records", terms: [] });
    expect(ast("   ")).toEqual({ target: "records", terms: [] });
    expect(matchesRecord(ast(""), rec())).toBe(true);
  });

  it("reads the time forms: a range, open ends, one instant, and several joined by OR", () => {
    const a = ast("t:120..300,>600,<=30,45,>=700");
    expect(a.terms[0]).toMatchObject({
      ranges: [
        { min: 120, max: 300, minOpen: false, maxOpen: false },
        { min: 600, max: Infinity, minOpen: true, maxOpen: false },
        { min: -Infinity, max: 30, minOpen: false, maxOpen: false },
        { min: 45, max: 45 },
        { min: 700, max: Infinity, minOpen: false },
      ],
    });
  });

  it("a metric term makes a metric filter: it takes a registered name, optionally a source, and no record-only key", () => {
    const a = ast("metric:agent.soc source:uav-002/body");
    expect(a.target).toBe("metrics");
    expect(ast("metric:sim.tickMs,sim.senseMs t:>10 agent:uav-002").target).toBe("metrics");
    expect(rejects("metric:agent.nope")).toMatch(/not a metric of the registry/);
    expect(rejects("metric:agent.soc kind:event")).toMatch(/does not apply to metric samples/);
    expect(rejects("metric:agent.soc text:x")).toMatch(/does not apply/);
  });

  it("rejects what is not in the language, with a reason: unknown keys, unknown kinds, tiers and sources, bad ids, numbers and records", () => {
    expect(rejects("colour:red")).toMatch(/unknown key/);
    expect(rejects("kind:nonsense")).toMatch(/unknown kind/);
    expect(rejects("tier:S3")).toMatch(/unknown tier/);
    expect(rejects("agent:UAV_1")).toMatch(/not an agent id/);
    expect(rejects("t:abc")).toMatch(/not a time or a range/);
    expect(rejects("t:300..120")).toMatch(/not a time or a range/);
    expect(rejects("cause:4812")).toMatch(/not a record number/);
    expect(rejects("cause:#-1")).toMatch(/not a record number/);
    expect(rejects("source:*/*")).toMatch(/matches everything/);
    expect(rejects("source:bogus/planner")).toMatch(/unknown owner/);
    expect(rejects("source:uav-001/nonsense")).toMatch(/unknown component/);
    expect(rejects("kind:")).toMatch(/needs a value/);
    expect(rejects("kind:event,")).toMatch(/empty value/);
    expect(rejects("just words")).toMatch(/not key:value/);
    expect(rejects('text:"unclosed')).toMatch(/quote/);
    expect(rejects("text:")).toMatch(/needs a value/);
  });

  it("limits the size of a filter, its terms and its values", () => {
    expect(rejects(`text:${"a".repeat(1100)}`)).toMatch(/at most 1024/);
    expect(rejects(Array.from({ length: 33 }, () => "kind:event").join(" "))).toMatch(/at most 32 terms/);
    expect(rejects(`agent:${Array.from({ length: 33 }, (_, i) => `uav-${i}`).join(",")}`)).toMatch(/at most 32 values/);
    expect(rejects(`text:${"a".repeat(201)}`)).toMatch(/1 to 200/);
  });

  it("SQL and shell metacharacters are in no value of the vocabulary: quotes, semicolons and comments are refused; free text is data", () => {
    for (const evil of ["agent:uav-1';DROP", "kind:event;--", "source:uav-001/planner'--", "metric:agent.soc;--", "tier:S1' OR '1'='1", "detector:a;b", "status:x'y", "cause:#1;--", "t:1;2"]) expect(rejects(evil), evil).toBeTruthy();
    // Free text is the one open value: it is data, and matches as such.
    const a = ast(`text:"'; DROP TABLE trace_records; --"`);
    expect(a.terms[0]).toMatchObject({ key: "text", text: "'; DROP TABLE trace_records; --" });
  });

  it("reads a quoted text with escapes", () => {
    expect(ast('text:"say \\"hi\\" \\\\"').terms[0]).toMatchObject({ text: 'say "hi" \\' });
    expect(ast("text:bare").terms[0]).toMatchObject({ text: "bare" });
  });
});

describe("the live predicate over records", () => {
  const m = (f: string, r: TraceRecord = rec()) => matchesRecord(ast(f), r);

  it("matches each key, a term's values as OR and the terms as AND", () => {
    expect(m("agent:uav-002")).toBe(true);
    expect(m("agent:ugv-001,uav-002")).toBe(true);
    expect(m("agent:ugv-001")).toBe(false);
    expect(m("kind:thought agent:uav-002")).toBe(true);
    expect(m("kind:thought agent:ugv-001")).toBe(false);
    expect(m("t:100..200")).toBe(true);
    expect(m("t:>150")).toBe(false);
    expect(m("t:>=150")).toBe(true);
    expect(m("t:<150")).toBe(false);
    expect(m("t:150")).toBe(true);
    expect(m("source:uav-002/planner")).toBe(true);
    expect(m("source:*/planner")).toBe(true);
    expect(m("source:uav-002/*")).toBe(true);
    expect(m("source:uav-001/*,*/reflexes")).toBe(false);
  });

  it("negates a term, and a negated term is true where the field is absent", () => {
    expect(m("-kind:thought")).toBe(false);
    expect(m("-kind:event")).toBe(true);
    expect(m("-agent:uav-002")).toBe(false);
    const world = rec({ source: "world/sim", kind: "event" });
    delete (world as { agentId?: string }).agentId;
    expect(m("-agent:uav-002", world)).toBe(true);
    expect(m("agent:uav-002", world)).toBe(false);
    expect(m("-tier:S1", world)).toBe(true);
  });

  it("text matches the payload's JSON, ASCII case-insensitively, as plain text", () => {
    expect(m('text:"battery low"')).toBe(true);
    expect(m("text:LOW")).toBe(true);
    expect(m('text:"battery  low"')).toBe(false);
    expect(m("text:%")).toBe(false);
    expect(m("text:_")).toBe(false);
    expect(m('text:"op\\":\\"decision"')).toBe(true);
  });

  it("cause and parent refer to records of the record's own run", () => {
    const r = rec({ parentId: "run-000001#4800", causeIds: ["run-000001#4812", "run-000001#2"] });
    expect(m("cause:#4812", r)).toBe(true);
    expect(m("cause:#9,#2", r)).toBe(true);
    expect(m("cause:#9", r)).toBe(false);
    expect(m("parent:#4800", r)).toBe(true);
    expect(m("parent:#4801", r)).toBe(false);
    expect(m("-parent:#4801", r)).toBe(true);
    expect(m("cause:#2", rec())).toBe(false);
  });

  it("detector and status read the payload's fields of those names, as strings", () => {
    const r = rec({ kind: "detector", payload: { detector: "late-decision", status: "failed", n: 5 } });
    expect(m("detector:late-decision", r)).toBe(true);
    expect(m("status:failed", r)).toBe(true);
    expect(m("status:ok", r)).toBe(false);
    expect(m("detector:late-decision", rec())).toBe(false);
  });

  it("a metric filter selects no records, and a record filter no samples", () => {
    expect(matchesRecord(ast("metric:agent.soc"), rec())).toBe(false);
    expect(matchesSample(ast("kind:event"), { source: "uav-002/body", name: "agent.soc", tick: 1, simTime: 0.1, value: 1 })).toBe(false);
  });
});

describe("the live predicate over metric samples", () => {
  const s = { source: "uav-002/body", name: "agent.soc", tick: 10, simTime: 1, value: 0.9 };
  const m = (f: string, x = s) => matchesSample(ast(f), x);

  it("metric with and without source, time and owner", () => {
    expect(m("metric:agent.soc")).toBe(true);
    expect(m("metric:agent.speedMps")).toBe(false);
    expect(m("metric:agent.soc source:uav-002/body")).toBe(true);
    expect(m("metric:agent.soc source:uav-001/body")).toBe(false);
    expect(m("metric:agent.soc source:*/body")).toBe(true);
    expect(m("metric:agent.soc source:uav-002/*")).toBe(true);
    expect(m("metric:agent.soc agent:uav-002")).toBe(true);
    expect(m("metric:agent.soc agent:uav-001")).toBe(false);
    expect(m("metric:agent.soc t:>=1")).toBe(true);
    expect(m("metric:agent.soc t:>1")).toBe(false);
    expect(m("metric:agent.soc -source:uav-002/body")).toBe(false);
    expect(m("metric:sim.tickMs source:world/sim", { ...s, source: "world/sim", name: "sim.tickMs" })).toBe(true);
  });
});
