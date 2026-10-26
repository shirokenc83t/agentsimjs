import { describe, expect, it } from "vitest";
import { commandHint, commandUnsupported } from "./commands.ts";

const facts = (over: Record<string, unknown> = {}) => ({ kind: "uav", airborne: false, soc: 0.9, hasBase: true, hasRangeSensor: true, ...over });

describe("a command the agent can never be given", () => {
  it("is not offered for a vehicle it is not for, and the words say why", () => {
    expect(commandUnsupported("takeoff", "Takeoff", facts({ kind: "ugv" }))).toBe("Takeoff is not for a ground vehicle");
    expect(commandUnsupported("takeoff", "Takeoff", facts())).toBeUndefined();
  });

  it("is not offered when the body lacks what it needs (a range sensor), but a condition that can change stays a hint on an offered command", () => {
    expect(commandUnsupported("explore", "Explore", facts({ airborne: true, hasRangeSensor: false }))).toMatch(/range sensor/);
    expect(commandUnsupported("land", "Land", facts({ airborne: false }))).toBeUndefined();
    expect(commandHint("land", "Land", facts({ airborne: false }))).toBe("Land needs airborne · take off first");
  });

  it("is undefined without facts", () => {
    expect(commandUnsupported("takeoff", "Takeoff", undefined)).toBeUndefined();
  });
});
