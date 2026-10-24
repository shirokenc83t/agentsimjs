import { describe, expect, it } from "vitest";
import { commandAvailability, describeUnavailable, preconditionHolds, type AgentFacts } from "./availability.ts";

// The one start-time predicate, as a function of the capability definitions and of a few facts: the runtime starts actions by it and the researcher's controls ask it before the click.

const caps = {
  vehicles: (name: string) => (name === "takeoff" ? ["uav"] : ["uav", "ugv"]),
  preconditions: (name: string): readonly { name: string; vehicles?: readonly string[] }[] =>
    name === "takeoff" ? [{ name: "grounded" }] : name === "land" ? [{ name: "airborne" }] : name === "explore" ? [{ name: "airborne", vehicles: ["uav"] }, { name: "hasRangeSensor" }] : [],
};
const uav = (over: Partial<AgentFacts> = {}): AgentFacts => ({ kind: "uav", airborne: false, soc: 0.9, hasBase: true, hasRangeSensor: true, ...over });

describe("availability of an action for an agent", () => {
  it("a grounded UAV cannot explore, land or fly a goTo until it has taken off, and the words say what to do first", () => {
    const explore = commandAvailability(caps, "explore", uav());
    expect(explore).toMatchObject({ code: "precondition_failed", requires: "airborne" });
    expect(describeUnavailable(explore as NonNullable<typeof explore>, "uav")).toBe("needs airborne · take off first");
    expect(commandAvailability(caps, "land", uav())?.requires).toBe("airborne");
    expect(commandAvailability(caps, "takeoff", uav())).toBeUndefined();
    // After takeoff the same predicate says the opposite.
    expect(commandAvailability(caps, "explore", uav({ airborne: true }))).toBeUndefined();
    const again = commandAvailability(caps, "takeoff", uav({ airborne: true }));
    expect(describeUnavailable(again as NonNullable<typeof again>, "uav")).toBe("needs to be on the ground · land first");
  });

  it("checks the vehicle first, then the battery, then the preconditions in the order the capability lists them", () => {
    expect(commandAvailability(caps, "takeoff", { ...uav(), kind: "ugv" })?.code).toBe("vehicle_unsupported");
    expect(commandAvailability(caps, "explore", uav({ soc: 0 }))?.code).toBe("battery_depleted");
    expect(commandAvailability(caps, "explore", uav({ airborne: true, hasRangeSensor: false }))?.requires).toBe("hasRangeSensor");
    // A precondition limited to another vehicle kind is skipped: a rover needs no takeoff to explore.
    expect(commandAvailability(caps, "explore", { kind: "ugv", airborne: false, soc: 1, hasBase: true, hasRangeSensor: true })).toBeUndefined();
    expect(commandAvailability(caps, "hold", uav())).toBeUndefined();
  });

  it("a precondition that is not known does not hold", () => {
    expect(preconditionHolds("nonsense", uav())).toBe(false);
  });
});
