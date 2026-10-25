import { describe, expect, it } from "vitest";
import { batteryWarning } from "./commands.ts";
import { actionLabel, reflexWords, type ActionView, type ReflexView } from "./panels/agent-views.ts";

// A rover whose battery is at its critical level is sent home by the battery reflex: the controls and the activity say so (T-082).

describe("the battery at its critical level", () => {
  const body = { battery: { criticalSoc: 0.15 } };
  it("warns before a command when the state of charge is at or below the critical level, and only then", () => {
    expect(batteryWarning(body, 0.16)).toBeUndefined();
    expect(batteryWarning(body, 0.15)).toContain("at or below its critical level (15 %)");
    expect(batteryWarning(body, 0.124)).toContain("12.4 %");
    expect(batteryWarning(body, 0)).toBeUndefined(); // an empty battery is refused by the runtime, not warned about
    expect(batteryWarning({}, 0.1)).toBeUndefined();
    expect(batteryWarning(undefined, 0.1)).toBeUndefined();
  });
});

describe("what an agent that a reflex took over is said to do", () => {
  const reflex: ReflexView = { reflex: "battery", code: "battery_critical", then: "returnToBase", atS: 72.1 };
  const act = (over: Partial<ActionView>): ActionView => ({ actionId: "act-1", name: "returnToBase", status: "running", phase: "following", failure: undefined, startedAtS: 72.1, ...over });
  it("says why it is returning to base, landing or holding, and by what an action was preempted", () => {
    expect(actionLabel(act({}), reflex)).toBe("returning to base: battery critical");
    expect(actionLabel(act({ name: "land" }), { ...reflex, then: "land" })).toBe("landing: battery critical");
    expect(actionLabel(act({ name: "explore", status: "preempted", startedAtS: 60, failure: "preempted" }), reflex)).toBe("explore · preempted · battery critical");
    expect(reflexWords("geofence")).toBe("outside the geofence");
    expect(reflexWords("some_new_code")).toBe("some new code");
  });
  it("leaves a return to base the researcher asked for as it is: the plain label", () => {
    expect(actionLabel(act({ startedAtS: 90 }), reflex)).toBe("returnToBase · following");
    expect(actionLabel(act({}), undefined)).toBe("returnToBase · following");
  });
});
