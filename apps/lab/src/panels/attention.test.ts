import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { attention, attentionCounts, isStuck, stuckCondition, withCondition, type BatteryFact } from "./attention.ts";

let seq = 0;
const rec = (simTime: number, kind: string, agentId: string, payload: Record<string, unknown>) => ({ seq: ++seq, simTime, kind, agentId, payload }) as unknown as TraceRecord;
const start = (t: number, agent: string, name = "goTo", id = `a${t}`) => rec(t, "action", agent, { op: "start", name, actionId: id });
const end = (t: number, agent: string, status: string, code?: string, id = `a${t}`) => rec(t, "action", agent, { op: "end", status, actionId: id, ...(code ? { failure: { code } } : {}) });
const levelOf = (m: Map<string, unknown>, id: string) => (m.get(id) as { level?: string } | undefined)?.level;
const labels = (m: ReturnType<typeof attention>, id: string) => m.get(id)?.conditions.map((c) => c.label);

describe("attention: failures", () => {
  it("a failed action is an alarm with its short label, until a new action has run two seconds without failing", () => {
    const records = [start(1, "u", "goTo", "g1"), end(5, "u", "failed", "unreachable", "g1"), start(6, "u", "goTo", "g2")];
    expect(levelOf(attention(records, 4), "u")).toBeUndefined();
    expect(labels(attention(records, 5), "u")).toEqual(["unreachable"]);
    expect(labels(attention(records, 7.5), "u")).toEqual(["unreachable"]); // the new action has run 1.5 s
    expect(attention(records, 8).get("u")?.level).toBeUndefined(); // 2 s: cleared
    // A new action that fails replaces it.
    const again = [...records, end(7, "u", "failed", "planning_budget", "g2")];
    expect(labels(attention(again, 9), "u")).toEqual(["plan budget"]);
  });

  it("each code has its own short label; an unknown one keeps its code", () => {
    const code = (c: string) => labels(attention([start(0, "u"), end(1, "u", "failed", c, "a0")], 1), "u");
    expect(code("collision")).toEqual(["collision"]);
    expect(code("no_map_data")).toEqual(["no map"]);
    expect(code("landing_blocked")).toEqual(["landing"]);
    expect(code("geofence")).toEqual(["geofence"]);
    expect(code("kinematically_infeasible")).toEqual(["infeasible"]);
    expect(code("something_new")).toEqual(["something_new"]);
  });

  it("boxed in: an infeasible failure after both recoveries found nothing", () => {
    const records = [
      start(1, "u", "goTo", "g1"),
      rec(3, "action", "u", { op: "recovery", kind: "escape", ok: false }),
      rec(3, "action", "u", { op: "recovery", kind: "back-off", ok: false }),
      end(3, "u", "failed", "kinematically_infeasible", "g1"),
    ];
    expect(labels(attention(records, 3), "u")).toEqual(["boxed in"]);
    // One recovery that worked is no box.
    const found = [start(1, "u", "goTo", "g1"), rec(3, "action", "u", { op: "recovery", kind: "escape", ok: false }), end(3, "u", "failed", "kinematically_infeasible", "g1")];
    expect(labels(attention(found, 3), "u")).toEqual(["infeasible"]);
  });

  it("a collision keeps its place for the pin", () => {
    const records = [start(1, "u", "goTo", "g1"), rec(2.9, "event", "u", { op: "collision", xM: 23.4, yM: 18 }), end(3, "u", "failed", "collision", "g1")];
    expect(attention(records, 3).get("u")?.conditions[0]?.at).toEqual({ xM: 23.4, yM: 18 });
  });

  it("an empty battery is an alarm that does not clear, from the status or from the failure", () => {
    const dead = new Map<string, BatteryFact>([["u", { soc: 0 }]]);
    expect(labels(attention([], 10, dead), "u")).toEqual(["battery 0"]);
    expect(labels(attention([start(1, "u"), end(2, "u", "failed", "battery_depleted", "a1"), start(3, "u")], 100), "u")).toEqual(["battery 0"]);
  });
});

describe("attention: warnings", () => {
  it("a rejected start is a warning until the next accepted start", () => {
    const records = [rec(1, "action", "u", { op: "rejected", name: "takeoff", failure: { code: "vehicle_unsupported" } })];
    expect(labels(attention(records, 1), "u")).toEqual(["rejected · vehicle_unsupported"]);
    expect(levelOf(attention([...records, start(2, "u")], 3), "u")).toBeUndefined();
  });

  it("a reflex is a warning for five seconds after its last firing", () => {
    const records = [rec(10, "reflex", "u", { reflex: "obstacle", code: "obstacle_ahead" })];
    expect(labels(attention(records, 12), "u")).toEqual(["obstacle"]);
    expect(levelOf(attention(records, 15.1), "u")).toBeUndefined();
    const again = [...records, rec(14, "reflex", "u", { reflex: "obstacle", code: "obstacle_ahead" })];
    expect(labels(attention(again, 17), "u")).toEqual(["obstacle"]);
  });

  it("a recovery is a warning while the action runs and for a few seconds", () => {
    const records = [start(1, "u", "goTo", "g1"), rec(2, "action", "u", { op: "recovery", kind: "escape", ok: true, reason: "x" })];
    expect(labels(attention(records, 3), "u")).toEqual(["recovering"]);
    expect(levelOf(attention(records, 8), "u")).toBeUndefined();
    expect(levelOf(attention([...records, end(4, "u", "succeeded", undefined, "g1")], 4.5), "u")).toBeUndefined();
  });

  it("the battery: low and critical are warnings from the status, critical after the reflex until the agent is home", () => {
    const low = new Map<string, BatteryFact>([["u", { soc: 0.28, lowSoc: 0.3, criticalSoc: 0.15 }]]);
    const critical = new Map<string, BatteryFact>([["u", { soc: 0.14, lowSoc: 0.3, criticalSoc: 0.15 }]]);
    expect(labels(attention([], 1, low), "u")).toEqual(["battery 28 %"]);
    expect(labels(attention([], 1, critical), "u")).toEqual(["battery 14 %"]);
    expect(attention([], 1, critical).get("u")?.conditions[0]?.code).toBe("battery_critical");
    const home = [rec(0.5, "reflex", "u", { reflex: "battery", code: "battery_critical" }), start(1, "u", "returnToBase", "r1"), end(9, "u", "succeeded", undefined, "r1")];
    expect(levelOf(attention(home, 9, critical), "u")).toBeUndefined();
  });

  it("stuck: no move beyond the footprint over thirty seconds while an action runs, and only with that much history", () => {
    const still = Array.from({ length: 70 }, (_, k) => ({ t: k * 0.5, x: 10 + (k % 2) * 0.1, y: 5 }));
    expect(isStuck(still, 34, 0.5, true)).toBe(true);
    expect(isStuck(still, 34, 0.5, false)).toBe(false); // no action running
    expect(isStuck(still.slice(40), 34, 0.5, true)).toBe(false); // history too short
    const moving = still.map((s, k) => ({ ...s, x: s.x + k * 0.2 }));
    expect(isStuck(moving, 34, 0.5, true)).toBe(false);
    expect(stuckCondition(34)).toMatchObject({ level: "warning", label: "stuck 30 s", glyph: "▲" });
  });
});

describe("attention: levels and counts", () => {
  it("the level is the highest of the conditions, alarms first, and a replay at a moment is the live run at that moment", () => {
    const records = [rec(1, "reflex", "u", { reflex: "obstacle", code: "obstacle_ahead" }), start(1, "u", "goTo", "g1"), end(2, "u", "failed", "unreachable", "g1")];
    const a = attention(records, 3).get("u");
    expect(a?.level).toBe("alarm");
    expect(a?.conditions.map((c) => c.glyph)).toEqual(["✕", "▲"]);
    // Records after the moment are not looked at: reading the whole run at 1.5 s is reading it as it was then.
    expect(attention(records, 1.5).get("u")?.conditions.map((c) => c.label)).toEqual(["obstacle"]);
    expect(withCondition(attention(records, 1.5).get("u"), stuckCondition(1.5)).conditions.map((c) => c.key)).toContain("stuck");
  });

  it("counts the agents at each level", () => {
    const m = attention([start(1, "a", "goTo", "g"), end(2, "a", "failed", "collision", "g"), rec(2, "reflex", "b", { reflex: "obstacle", code: "obstacle_ahead" }), rec(2, "reflex", "c", { reflex: "obstacle", code: "obstacle_ahead" })], 3);
    expect(attentionCounts(m)).toEqual({ alarm: 1, warning: 2 });
  });
});
