import { describe, expect, it } from "vitest";
import {
  COMPONENTS_BY_OWNER,
  isValidSource,
  isValidSourcePattern,
  matchesSource,
  ownerKind,
  parseSource,
  parseSourceFilter,
  SOURCE_COMPONENTS,
  sourceOf,
} from "./source.ts";
import { TraceBuffer } from "./trace-buffer.ts";
import { firstNonMonotonicRecord } from "./trace-record.ts";

describe("trace source vocabulary (ADR-0031)", () => {
  it("classifies owners by kind", () => {
    expect(["uav-002", "ugv-010", "ev-001", "virt-001", "grp-003", "clean-tasks#17", "world"].map(ownerKind)).toEqual([
      "agent", "agent", "agent", "virtual", "group", "protocol", "world",
    ]);
    for (const bad of ["drone-1", "uav", "UAV-001", "grp-x", "#17", "world2", "a b", ""]) expect(ownerKind(bad), bad).toBeUndefined();
  });

  it.each([
    ["uav-002/planner", true],
    ["uav-002/s1", true],
    ["uav-002/s2", true],
    ["virt-001/comms", true],
    ["grp-001/policy", true],
    ["clean-tasks#17/protocol", true],
    ["world/sim", true],
    ["world/storage", true],
    ["ugv-001/config", true], // the agent's configuration record (ADR-0028 addition of 2026-10-10)
    ["virt-001/config", true],
    ["world/config", false],
    ["grp-001/config", false],
    ["uav-002/mind", false], // S1 and S2 stay separate; there is no generic mind
    ["virt-001/body", false], // virtual agents have no body
    ["grp-001/planner", false],
    ["clean-tasks#17", false], // no instance-only form
    ["world/planner", false],
    ["uav-002/planner/extra", false],
    ["/planner", false],
    ["uav-002/", false],
    [`uav-${"9".repeat(100)}/planner`, false], // over 96 characters
  ])("%s → %s", (s, valid) => {
    expect(isValidSource(s)).toBe(valid);
  });

  it("every component is allowed for at least one owner kind, and the vocabulary is closed", () => {
    const used = new Set(Object.values(COMPONENTS_BY_OWNER).flat());
    expect([...used].sort()).toEqual([...SOURCE_COMPONENTS].sort());
    expect(parseSource("uav-002/reflexes")).toEqual({ owner: "uav-002", component: "reflexes", ownerKind: "agent" });
    expect(() => sourceOf("world", "planner")).toThrow();
  });
});

describe("source filters", () => {
  it("parses exact, owner-wildcard, component-wildcard and OR lists", () => {
    const r = parseSourceFilter("uav-002/planner,uav-003/*,*/reflexes");
    expect(r.ok && r.value).toEqual([
      { owner: "uav-002", component: "planner" },
      { owner: "uav-003", component: null },
      { owner: null, component: "reflexes" },
    ]);
    if (!r.ok) return;
    expect(matchesSource(r.value, "uav-002/planner")).toBe(true);
    expect(matchesSource(r.value, "uav-002/body")).toBe(false);
    expect(matchesSource(r.value, "uav-003/s2")).toBe(true);
    expect(matchesSource(r.value, "ugv-001/reflexes")).toBe(true);
    expect(matchesSource(r.value, "world/sim")).toBe(false);
  });

  it.each([
    "*/*",
    "uav-002",
    "uav-*/planner", // * only as a whole segment
    "uav-002/plan*",
    "nobody-1/planner",
    "uav-002/telepathy",
    "world/planner",
    "uav-002/planner'; DROP TABLE trace_records; --",
    "uav-002/planner OR 1=1",
    "%/planner",
    "uav-002/_lanner",
    "",
    Array.from({ length: 33 }, () => "world/sim").join(","),
    "x".repeat(2000),
  ])("rejects %s", (value) => {
    const r = parseSourceFilter(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_source_filter");
  });

  it("re-validates patterns received across a boundary", () => {
    expect(isValidSourcePattern({ owner: "uav-002", component: null })).toBe(true);
    expect(isValidSourcePattern({ owner: null, component: null })).toBe(false);
    expect(isValidSourcePattern({ owner: "x' OR '1'='1", component: null })).toBe(false);
    expect(isValidSourcePattern({ owner: null, component: "drop" as never })).toBe(false);
  });
});

describe("run invariant: seq order is sim-time order (ADR-0031 amendment)", () => {
  it("finds the first record whose time goes backwards, per run", () => {
    const r = (runId: string, seq: number, simTime: number) => ({ runId, seq, simTime });
    expect(firstNonMonotonicRecord([r("a", 2, 0.2), r("a", 0, 0), r("a", 1, 0.1), r("b", 0, 5)])).toBeUndefined();
    expect(firstNonMonotonicRecord([r("a", 0, 0), r("a", 1, 0.1), r("a", 2, 0.1)])).toBeUndefined(); // equal times are fine
    expect(firstNonMonotonicRecord([r("a", 0, 0.3), r("a", 1, 0.2)])).toEqual(r("a", 1, 0.2));
    // Runs are independent: a later run may start at an earlier time.
    expect(firstNonMonotonicRecord([r("a", 0, 9), r("b", 0, 1)])).toBeUndefined();
  });

  it("the trace buffer refuses records whose time goes backwards", () => {
    const buf = new TraceBuffer("run-000001", () => 0);
    const t = buf.for("world/sim");
    t.append({ simTime: 1, kind: "event", payload: {} });
    t.append({ simTime: 1, kind: "event", payload: {} });
    expect(() => t.append({ simTime: 0.5, kind: "event", payload: {} })).toThrow(/backwards/);
  });
});

describe("tracer handles", () => {
  it("stamp the bound source on every record and refuse invalid sources", () => {
    const buf = new TraceBuffer("run-000001", () => 0);
    const planner = buf.for("uav-001/planner");
    expect(buf.for("uav-001/planner")).toBe(planner);
    const r = planner.append({ simTime: 0.1, kind: "plan", agentId: "uav-001", payload: {} });
    expect(r.source).toBe("uav-001/planner");
    // Subject and emitter can differ: the simulator emits a record about an agent.
    expect(buf.for("world/sim").append({ simTime: 0.1, kind: "event", agentId: "uav-001", payload: {} }).source).toBe("world/sim");
    expect(() => buf.for("uav-001/mind")).toThrow();
  });
});
