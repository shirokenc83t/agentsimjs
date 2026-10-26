import type { AgentFacts } from "@agentsim/core";
import type { RunConfigDocument } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import { actionMenu, alongList, defaultArgs, fieldIssues, insertStep, missionOf, missionStatus, moveStep, removeStep, withMission, type MissionStep } from "./mission-model.ts";

// The model of the step editor (F3c M1): pure functions over the run configuration's mission list and the capability manifest, so the component only draws them.

const DOC = { schemaVersion: 0, scenario: { id: "f2-discovery", version: 1 } } as unknown as RunConfigDocument;
const UAV_GROUNDED: AgentFacts = { kind: "uav", airborne: false, soc: 1, hasBase: true, hasRangeSensor: true };
const UGV: AgentFacts = { kind: "ugv", airborne: false, soc: 1, hasBase: true, hasRangeSensor: true };
const TAKEOFF: MissionStep = { action: "takeoff", args: { altitudeM: 20 } };
const GOTO: MissionStep = { action: "goTo", args: { xM: 50, yM: 20 } };
const EXPLORE: MissionStep = { action: "explore", args: { radiusM: 20 } };
const HOME: MissionStep = { action: "returnToBase" };
const LAND: MissionStep = { action: "land" };

describe("the mission in the run configuration", () => {
  it("is read from and written to minds.byAgent of the agent's key, and clearing it removes the entry and an empty section", () => {
    expect(missionOf(DOC, "scout")).toEqual([]);
    const a = withMission(DOC, "scout", [TAKEOFF, GOTO]);
    expect(missionOf(a, "scout")).toEqual([TAKEOFF, GOTO]);
    expect(a.minds?.byAgent?.["scout"]).toEqual({ s1: { script: { name: "sequence", params: { steps: [TAKEOFF, GOTO] } } } });
    const b = withMission(a, "rover", [{ action: "hold", args: { durationS: 5 } }]);
    expect(Object.keys(b.minds?.byAgent ?? {})).toEqual(["scout", "rover"]);
    const c = withMission(withMission(a, "scout", []), "scout", []);
    expect(c.minds).toBeUndefined();
    expect(withMission(b, "scout", []).minds?.byAgent).toEqual({ rover: expect.anything() });
  });

  it("is a list that is edited by inserting, moving and removing steps, each a new list", () => {
    const l = [TAKEOFF, GOTO, HOME];
    expect(insertStep(l, 2, EXPLORE).map((s) => s.action)).toEqual(["takeoff", "goTo", "explore", "returnToBase"]);
    expect(insertStep(l, 0, LAND).map((s) => s.action)[0]).toBe("land");
    expect(moveStep(l, 1, -1).map((s) => s.action)).toEqual(["goTo", "takeoff", "returnToBase"]);
    expect(moveStep(l, 1, 1).map((s) => s.action)).toEqual(["takeoff", "returnToBase", "goTo"]);
    expect(moveStep(l, 0, -1)).toEqual(l); // at the top: nothing moves
    expect(moveStep(l, 2, 1)).toEqual(l);
    expect(removeStep(l, 1).map((s) => s.action)).toEqual(["takeoff", "returnToBase"]);
    expect(l).toHaveLength(3); // the original is untouched
  });
});

describe("the actions that can be added", () => {
  it("are the manifest's actions, each with what it needs, and an action the vehicle does not support is listed with the reason", () => {
    const uav = actionMenu("uav");
    expect(uav.map((m) => m.name).sort()).toEqual(["explore", "goTo", "hold", "land", "returnToBase", "takeoff"]);
    expect(uav.every((m) => m.supported)).toBe(true);
    expect(uav.find((m) => m.name === "takeoff")?.needs).toContain("on the ground");
    expect(uav.find((m) => m.name === "goTo")?.needs).toContain("airborne");
    const ugv = actionMenu("ugv");
    expect(ugv.find((m) => m.name === "takeoff")).toMatchObject({ supported: false, why: "not offered for a ground vehicle" });
    expect(ugv.find((m) => m.name === "goTo")?.supported).toBe(true);
  });

  it("have default arguments the manifest accepts, so a step added with one click is valid", () => {
    for (const name of ["takeoff", "goTo", "explore", "hold", "returnToBase", "land"]) {
      const step = { action: name, args: defaultArgs(name, { cruiseAltitudeM: 20, x: 10, y: 12 }) };
      expect(fieldIssues(step), name).toEqual([]);
    }
    expect(defaultArgs("takeoff", { cruiseAltitudeM: 25 })).toEqual({ altitudeM: 25 });
    expect(defaultArgs("goTo", { x: 10, y: 12 })).toEqual({ xM: 10, yM: 12 });
  });
});

describe("whether each step can run, along the list", () => {
  it("follows what the steps before leave: take off makes a UAV airborne, land and return home leave it on the ground", () => {
    const rows = alongList([TAKEOFF, GOTO, EXPLORE, HOME, LAND], UAV_GROUNDED);
    expect(rows.map((r) => r.ok)).toEqual([true, true, true, true, false]);
    expect(rows.map((r) => r.after)).toEqual(["airborne", "airborne", "airborne", "grounded", "grounded"]);
    const last = rows[4];
    expect(last?.hint).toBe("returnToBase already lands the UAV · remove this step");
    expect(last?.removeAt).toBe(4);
    expect(last?.because).toContain("returnToBase");
  });

  it("says goTo needs airborne, with the one-click fix: take off before it, and moving take off up does the same", () => {
    const rows = alongList([GOTO, TAKEOFF], UAV_GROUNDED);
    expect(rows[0]).toMatchObject({ ok: false, hint: "goTo needs airborne · take off first", fix: { insert: { action: "takeoff" }, at: 0 } });
    expect(rows[1]?.ok).toBe(true);
    expect(rows[1]?.after).toBe("airborne");
  });

  it("says take off needs the ground when the UAV is already airborne, with land as its fix", () => {
    const rows = alongList([TAKEOFF, TAKEOFF], UAV_GROUNDED);
    expect(rows[1]).toMatchObject({ ok: false, fix: { insert: { action: "land" }, at: 1 } });
    expect(rows[1]?.hint).toMatch(/^takeoff needs/);
  });

  it("starts from the state the agent starts in (airborne at the start: take off is refused, goTo is fine)", () => {
    const rows = alongList([GOTO, TAKEOFF], { ...UAV_GROUNDED, airborne: true });
    expect(rows.map((r) => r.ok)).toEqual([true, false]);
  });

  it("gives a ground vehicle no airborne state, and marks a step its vehicle does not support as not for it, with no fix", () => {
    const rows = alongList([GOTO, EXPLORE, TAKEOFF, HOME], UGV);
    expect(rows.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(rows[2]).toMatchObject({ hint: "takeoff is not for a ground vehicle", fix: undefined });
    expect(rows[0]?.after).toBeUndefined();
  });

  it("warns that a hold with no duration never ends: the steps after it do not run", () => {
    const rows = alongList([TAKEOFF, { action: "hold" }, GOTO], UAV_GROUNDED);
    expect(rows[1]?.note).toMatch(/never ends/);
    expect(rows[2]?.note).toMatch(/does not run/);
    expect(alongList([TAKEOFF, { action: "hold", args: { durationS: 5 } }, GOTO], UAV_GROUNDED).every((r) => r.note === undefined)).toBe(true);
  });

  it("states the resume rule of each action, from the core's rule: none resumes after a preemption", () => {
    const rows = alongList([TAKEOFF, GOTO], UAV_GROUNDED);
    expect(rows.map((r) => r.resume)).toEqual(["does not resume after a preemption", "does not resume after a preemption"]);
  });
});

describe("the arguments of a step", () => {
  it("are checked against the action's schema in words: a number below its minimum, a missing required field, an unknown field", () => {
    expect(fieldIssues({ action: "explore", args: { radiusM: 0 } })).toEqual([expect.stringContaining("radiusM")]);
    expect(fieldIssues({ action: "takeoff", args: {} })[0]).toContain("altitudeM");
    expect(fieldIssues({ action: "goTo", args: { xM: 3 } })[0]).toContain("yM");
    expect(fieldIssues({ action: "land", args: { z: 1 } })).not.toEqual([]);
    expect(fieldIssues({ action: "explore", args: { radiusM: 20 } })).toEqual([]);
  });
});

describe("the state of a mission in the section's header and the jump row", () => {
  it("is valid with its number of steps, or says how many steps cannot run or are wrong", () => {
    expect(missionStatus([TAKEOFF, GOTO, EXPLORE], UAV_GROUNDED)).toEqual({ steps: 3, errors: 0, warnings: 0, valid: true });
    expect(missionStatus([GOTO, TAKEOFF], UAV_GROUNDED)).toEqual({ steps: 2, errors: 0, warnings: 1, valid: false });
    expect(missionStatus([TAKEOFF, { action: "explore", args: { radiusM: 0 } }], UAV_GROUNDED)).toEqual({ steps: 2, errors: 1, warnings: 0, valid: false });
    expect(missionStatus([], UAV_GROUNDED)).toEqual({ steps: 0, errors: 0, warnings: 0, valid: true });
  });
});
