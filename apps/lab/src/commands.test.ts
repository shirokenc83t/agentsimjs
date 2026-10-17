import { describe, expect, it } from "vitest";
import { agentBody, AGENT_COMMANDS, commandParams } from "./commands.ts";

describe("researcher agent commands", () => {
  it("are the injectable actions besides goTo, and only takeoff has parameters (its altitude, defaulting to the body's cruise altitude)", () => {
    expect(AGENT_COMMANDS.map((c) => c.op)).toEqual(["takeoff", "land", "explore", "hold"]);
    expect(commandParams("takeoff", { cruiseAltitudeM: 25 })).toEqual({ altitudeM: 25 });
    expect(commandParams("takeoff", { cruiseAltitudeM: 25 }, 8)).toEqual({ altitudeM: 8 });
    expect(commandParams("takeoff", undefined)).toEqual({ altitudeM: 10 });
    for (const op of ["land", "explore", "hold"] as const) expect(commandParams(op, { cruiseAltitudeM: 25 })).toBeUndefined();
  });

  it("reads an agent's body from the loaded run", () => {
    const run = { agents: [{ id: "uav-001", config: { body: { cruiseAltitudeM: 20 } } }, { id: "ugv-001" }] };
    expect(agentBody(run, "uav-001")).toEqual({ cruiseAltitudeM: 20 });
    expect(agentBody(run, "ugv-001")).toBeUndefined();
    expect(agentBody(undefined, "x")).toBeUndefined();
  });
});
