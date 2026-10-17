import type { AgentSpec } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import { BODY_FIELDS, bodyValue, bodyWarnings, effectiveBodyValue, withBodyValue } from "./body-fields.ts";

const ugv: AgentSpec = { kind: "ugv", key: "rover", start: { xM: 1, yM: 1 } };

describe("body form fields (generated from the body schemas)", () => {
  it("lists every scalar body parameter, nested battery and energy flattened, with ranges and enum options", () => {
    const names = (k: "uav" | "ugv") => BODY_FIELDS[k].map((f) => f.path.join("."));
    expect(names("ugv")).toEqual(expect.arrayContaining(["drive", "reverseAllowed", "maxSpeedMps", "lookaheadM", "battery.capacityWh", "battery.criticalSoc", "energy.idleW", "onboardComputeExpansionsPerTick"]));
    expect(names("uav")).toEqual(expect.arrayContaining(["cruiseAltitudeM", "clearanceM", "battery.initialSoc"]));
    expect(names("uav")).not.toContain("drive");
    expect(BODY_FIELDS.ugv.find((f) => f.path.join(".") === "drive")).toEqual({ path: ["drive"], kind: "enum", options: ["differential", "ackermann", "forward-only"] });
    expect(BODY_FIELDS.ugv.find((f) => f.path.join(".") === "battery.initialSoc")).toMatchObject({ kind: "number", min: 0, max: 1 });
    expect(BODY_FIELDS.ugv.find((f) => f.path.join(".") === "onboardComputeExpansionsPerTick")).toMatchObject({ kind: "integer", min: 100 });
  });

  it("every field has a built-in default to show as its placeholder", () => {
    for (const kind of ["uav", "ugv"] as const) {
      const agent: AgentSpec = { kind, start: { xM: 0, yM: 0 } } as AgentSpec;
      for (const f of BODY_FIELDS[kind]) expect(effectiveBodyValue(agent, f.path), `${kind} ${f.path.join(".")}`).toBeDefined();
    }
  });

  it("sets and clears values, removing empty nested objects and an empty body", () => {
    const a = withBodyValue(ugv, ["battery", "criticalSoc"], 0.3);
    expect(a.body).toEqual({ battery: { criticalSoc: 0.3 } });
    expect(bodyValue(a, ["battery", "criticalSoc"])).toBe(0.3);
    expect(effectiveBodyValue(a, ["battery", "capacityWh"])).toBeGreaterThan(0);
    const b = withBodyValue(withBodyValue(a, ["maxSpeedMps"], 1.5), ["battery", "criticalSoc"], undefined);
    expect(b.body).toEqual({ maxSpeedMps: 1.5 });
    expect(withBodyValue(b, ["maxSpeedMps"], undefined)).toEqual(ugv);
  });

  it("reports the loader's body warnings with their codes", () => {
    const cut = withBodyValue(withBodyValue(ugv, ["drive"], "forward-only"), ["lookaheadM"], 3);
    expect(bodyWarnings(cut, 2).map((w) => [w.code, w.path])).toContainEqual(["lookahead_exceeds_turning_radius", "/agents/2/body/lookaheadM"]);
    expect(bodyWarnings(ugv, 0)).toEqual([]);
  });
});
