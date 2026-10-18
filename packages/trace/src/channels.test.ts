import { describe, expect, it } from "vitest";
import { CHANNELS, CHANNEL_RULES, channelOf } from "./channels.ts";
import { TRACE_KINDS } from "./trace-record.ts";

// F3a M2: the closed mapping of records to channels (ADR-0035 addition of 2026-10-17, item 1). The test that every record the
// reference runs emit is mapped is in packages/scenarios (channel-mapping.test.ts); here the rules themselves.

const rec = (kind: string, source: string, op?: string) => ({ kind, source, payload: op === undefined ? {} : { op } }) as Parameters<typeof channelOf>[0];

describe("channelOf", () => {
  it("puts events, actions, reflexes, injected commands, degradations, lifecycle and sensor contacts in `events`", () => {
    expect(channelOf(rec("event", "uav-001/actions", "event"))).toBe("events");
    expect(channelOf(rec("event", "uav-001/s1", "timer-set"))).toBe("events");
    expect(channelOf(rec("event", "uav-001/sensors", "dropout"))).toBe("events");
    expect(channelOf(rec("event", "ugv-002/beliefs", "frontier-mark"))).toBe("events");
    expect(channelOf(rec("action", "uav-001/actions", "start"))).toBe("events");
    expect(channelOf(rec("action", "uav-001/actions", "end"))).toBe("events");
    expect(channelOf(rec("action", "uav-001/actions", "explore-target"))).toBe("events");
    expect(channelOf(rec("reflex", "uav-001/reflexes"))).toBe("events");
    expect(channelOf(rec("injected", "world/sim", "command"))).toBe("events");
    expect(channelOf(rec("degradation", "world/sim"))).toBe("events");
    expect(channelOf(rec("lifecycle", "uav-001/config", "config"))).toBe("events");
    expect(channelOf(rec("observation", "uav-001/sensors", "contact"))).toBe("events");
    expect(channelOf(rec("thought", "uav-001/s1", "decision"))).toBe("events");
  });

  it("puts the observer's belief-vs-truth samples in `beliefs`, not in `events`", () => {
    expect(channelOf(rec("event", "world/sim", "belief-vs-truth"))).toBe("beliefs");
  });

  it("puts the notes of a running action (hold, leg, replan) in `transitions`, with plan nodes and policy rules", () => {
    for (const op of ["hold", "leg", "replan"]) expect(channelOf(rec("action", "uav-001/actions", op)), op).toBe("transitions");
    expect(channelOf(rec("plan-node", "uav-001/actions"))).toBe("transitions");
    expect(channelOf(rec("policy-rule", "grp-001/policy"))).toBe("transitions");
  });

  it("puts algorithm queries in `compute`, and the plan records that carry geometry", () => {
    expect(channelOf(rec("compute", "uav-001/planner", "plan"))).toBe("compute");
    expect(channelOf(rec("compute", "uav-001/planner", "restart"))).toBe("compute");
    expect(channelOf(rec("plan", "uav-001/planner"))).toBe("compute");
  });

  it("puts requests and the space summaries they refer to in `mind-io`", () => {
    expect(channelOf(rec("thought", "uav-001/s1", "request"))).toBe("mind-io");
    expect(channelOf(rec("thought", "uav-001/s1", "space"))).toBe("mind-io");
  });

  it("puts pose samples in `poses` only when they come from the agent's body", () => {
    expect(channelOf(rec("observation", "uav-001/body", "pose"))).toBe("poses");
    expect(channelOf(rec("observation", "uav-001/sensors", "pose"))).toBe("events");
  });

  it("puts checkpoint and snapshot records in `checkpoints`", () => {
    expect(channelOf(rec("snapshot", "world/sim"))).toBe("checkpoints");
    expect(channelOf(rec("event", "world/sim", "checkpoint"))).toBe("checkpoints");
  });

  it("does not map what no phase emits yet (protocol, contract, group, policy): an unmapped record is undefined", () => {
    for (const kind of ["protocol", "contract", "group", "policy"]) expect(channelOf(rec(kind, "world/sim")), kind).toBeUndefined();
    expect(channelOf(rec("telepathy", "world/sim"))).toBeUndefined();
  });

  it("has only known channels and known kinds in its rules, and no two rules with the same key", () => {
    const keys = new Set<string>();
    for (const r of CHANNEL_RULES) {
      expect(CHANNELS).toContain(r.channel);
      expect(TRACE_KINDS).toContain(r.kind);
      const key = `${r.kind}|${r.component ?? "*"}|${r.op ?? "*"}`;
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
    }
  });

  it("maps a record by its most specific rule: a generic `event` is `events`, a belief-vs-truth one is `beliefs`", () => {
    expect(channelOf(rec("event", "world/sim", "belief-vs-truth"))).toBe("beliefs");
    expect(channelOf(rec("event", "world/sim", "anything"))).toBe("events");
    expect(channelOf(rec("event", "world/sim"))).toBe("events");
  });
});
