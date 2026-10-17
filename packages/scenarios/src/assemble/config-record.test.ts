import { matchesSource, parseSourceFilter } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { buildReferenceRun } from "../testing/reference-run.ts";

describe("per-agent config records (ADR-0028; form from its addition of 2026-10-10)", () => {
  it("one lifecycle `config` record per agent at time 0, in ID order, from <agent>/config, with the resolved configuration", () => {
    const run = buildReferenceRun({ scripts: {}, runConfig: { beliefs: { default: { init: "unknown" }, byAgent: { scout: { init: "ideal" } } } } });
    const recs = run.trace.all().filter((r) => r.kind === "lifecycle" && (r.payload as { op?: string }).op === "config");
    expect(recs.map((r) => r.agentId)).toEqual(run.agents.map((a) => a.id));
    for (const r of recs) {
      expect(r.source).toBe(`${r.agentId}/config`);
      expect(r.simTime).toBe(0);
      const cfg = run.resolved.agents.find((a) => a.agentId === r.agentId);
      expect(r.payload).toEqual({
        op: "config",
        key: cfg?.key,
        planning: cfg?.planning,
        planningSources: cfg?.planningSources,
        body: cfg?.body,
        beliefs: cfg?.beliefs,
        beliefsSource: cfg?.beliefsSource,
        topology: cfg?.topology,
      });
    }
    const scout = run.agents.find((a) => a.key === "scout");
    const labelled = recs.filter((r) => (r.payload as { beliefs: { idealized: boolean } }).beliefs.idealized).map((r) => r.agentId);
    expect(labelled).toEqual([scout?.id]);
  });

  it("the source filter finds exactly these records (every agent with the owner wildcard, or one agent)", () => {
    const run = buildReferenceRun({ scripts: {} });
    const all = parseSourceFilter("*/config");
    if (!all.ok) throw new Error(all.error.message);
    const found = run.trace.all().filter((r) => matchesSource(all.value, r.source));
    expect(found.length).toBe(run.agents.length);
    expect(found.every((r) => r.kind === "lifecycle" && (r.payload as { op: string }).op === "config")).toBe(true);
    const one = parseSourceFilter(`${run.agents[0]?.id}/config`);
    if (!one.ok) throw new Error(one.error.message);
    expect(run.trace.all().filter((r) => matchesSource(one.value, r.source))).toHaveLength(1);
  });
});
