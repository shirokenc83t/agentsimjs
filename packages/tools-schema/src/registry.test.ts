import { describe, expect, it } from "vitest";
import { VEHICLE_KINDS } from "./capability.ts";
import { capabilityManifest } from "./exposures/manifest.ts";
import { CAPABILITIES, COMMON_FAILURE_CODES, getCapability, INJECTABLE_COMMANDS, isInjectable, PRECONDITIONS, validateParams } from "./registry.ts";

const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;

describe("capability definitions (ADR-0007)", () => {
  it("defines the base actions (F1, and explore from F2)", () => {
    expect(CAPABILITIES.filter((c) => c.kind === "action").map((c) => c.name)).toEqual(["explore", "goTo", "hold", "land", "returnToBase", "takeoff"]);
    expect(CAPABILITIES.filter((c) => c.kind === "bookkeeping").map((c) => c.name)).toEqual(["cancelTimer", "note", "setTimer"]); // timers (F2 M2d) and the notebook (F4)
  });

  it("has unique camelCase names", () => {
    const names = CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(CAMEL);
  });

  it.each(CAPABILITIES.map((c) => [c.name, c] as const))("%s: metadata is complete and consistent", (_, c) => {
    expect(c.description.length).toBeGreaterThan(40);
    expect(c.description.length).toBeLessThan(1200);
    expect(c.vehicles.length).toBeGreaterThan(0);
    for (const v of c.vehicles) expect(VEHICLE_KINDS).toContain(v);
    // Base actions are called by the agent's own mind.
    expect(c.scope).toBe("self");
    for (const p of c.preconditions) {
      expect(Object.keys(PRECONDITIONS)).toContain(p.name);
      for (const v of p.vehicles ?? []) expect(c.vehicles).toContain(v);
    }
    for (const code of c.failureCodes) {
      expect(code).toMatch(SNAKE);
      expect(COMMON_FAILURE_CODES as readonly string[]).not.toContain(code);
    }
    expect(new Set(c.failureCodes).size).toBe(c.failureCodes.length);
  });

  it.each(CAPABILITIES.map((c) => [c.name, c] as const))("%s: params are a closed object and every field is described for LLMs", (_, c) => {
    const schema = JSON.parse(JSON.stringify(c.params)) as { type: string; additionalProperties: boolean; properties: Record<string, { description?: string }> };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    for (const [k, p] of Object.entries(schema.properties)) {
      expect(p.description, k).toBeTruthy();
      expect(k).toMatch(CAMEL);
    }
  });

  it("common failure codes are snake_case and unique", () => {
    for (const c of COMMON_FAILURE_CODES) expect(c).toMatch(SNAKE);
    expect(new Set(COMMON_FAILURE_CODES).size).toBe(COMMON_FAILURE_CODES.length);
  });
});

describe("validateParams", () => {
  it.each([
    ["goTo", { xM: 120.5, yM: 40 }],
    ["goTo", { xM: 0, yM: 0, altitudeM: 30 }],
    ["hold", {}],
    ["hold", { durationS: 5 }],
    ["returnToBase", {}],
    ["takeoff", { altitudeM: 20 }],
    ["land", {}],
  ])("accepts valid %s params %j", (name, params) => {
    const r = validateParams(name, params);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["goTo", {}, "missing fields"],
    ["goTo", { xM: 1 }, "missing yM"],
    ["goTo", { xM: "12", yM: 3 }, "string number"],
    ["goTo", { xM: Number.NaN, yM: 0 }, "NaN"],
    ["goTo", { xM: Number.POSITIVE_INFINITY, yM: 0 }, "Infinity"],
    ["goTo", { xM: 1e7, yM: 0 }, "above the coordinate limit"],
    ["goTo", { xM: 0, yM: 0, altitudeM: -1 }, "negative altitude"],
    ["goTo", { xM: 0, yM: 0, speed: 3 }, "unknown field"],
    ["goTo", null, "null"],
    ["goTo", [1, 2], "array"],
    ["hold", { durationS: 0 }, "zero duration"],
    ["hold", { durationS: 1e9 }, "duration above the limit"],
    ["takeoff", {}, "missing altitude"],
    ["takeoff", { altitudeM: 0 }, "zero altitude"],
    ["land", { xM: 1 }, "unknown field"],
  ] as [string, unknown, string][])("rejects %s params %j (%s)", (name, params) => {
    const r = validateParams(name, params);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_params");
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects injection attempts and prototype keys (agents never ship code, ADR-0008)", () => {
    const attempts: unknown[] = [
      JSON.parse('{"xM": 1, "yM": 2, "__proto__": {"polluted": true}}'),
      JSON.parse('{"xM": 1, "yM": 2, "constructor": {"prototype": {}}}'),
      { xM: "process.exit()", yM: 0 },
      { xM: { valueOf: "() => 1" }, yM: 0 },
      { xM: 1, yM: 2, altitudeM: "${7*7}" },
    ];
    for (const a of attempts) expect(validateParams("goTo", a).ok, JSON.stringify(a)).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects unknown capabilities, including prototype names", () => {
    for (const name of ["fly", "__proto__", "constructor", "toString", "GOTO"]) {
      const r = validateParams(name, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("unknown_capability");
      expect(getCapability(name)).toBeUndefined();
    }
  });
});

describe("timer capabilities (bookkeeping, ADR-0005 addition of 2026-10-09)", () => {
  it.each([
    ["setTimer", { delayS: 5, tag: "wake-up" }],
    ["setTimer", { delayS: 0.1, tag: "a" }],
    ["cancelTimer", { tag: "wake-up" }],
    ["note", { text: "visit B then C", mode: "replace" }],
    ["note", { text: "", mode: "append" }],
  ])("%s accepts %j", (name, params) => {
    expect(validateParams(name, params).ok).toBe(true);
  });

  it.each([
    ["note", { text: "x" }, "a note without a mode"],
    ["note", { text: "x", mode: "prepend" }, "a mode that does not exist"],
    ["note", { mode: "append" }, "a note without text"],
    ["setTimer", { tag: "wake" }, "missing delay"],
    ["setTimer", { delayS: "5", tag: "wake" }, "string delay"],
    ["setTimer", { delayS: 5, tag: "Wake Up" }, "tag with capitals and a space"],
    ["setTimer", { delayS: 5, tag: "9lives" }, "tag starting with a digit"],
    ["setTimer", { delayS: 5, tag: "a".repeat(33) }, "tag over 32 characters"],
    ["setTimer", { delayS: 5, tag: "x'; DROP TABLE timers; --" }, "injection attempt in the tag"],
    ["setTimer", { delayS: 5, tag: "${7*7}" }, "template evaluation attempt"],
    ["setTimer", { delayS: 5, tag: "a", extra: true }, "unknown field"],
    ["cancelTimer", {}, "missing tag"],
    ["cancelTimer", { tag: "../etc" }, "path-like tag"],
  ])("%s rejects %j (%s)", (name, params, _why) => {
    expect(validateParams(name, params).ok).toBe(false);
  });

  it("are bookkeeping, self-scope, for every vehicle, with stable failure codes and no preconditions", () => {
    for (const n of ["setTimer", "cancelTimer"]) {
      const c = getCapability(n);
      expect([c?.kind, c?.scope, c?.preconditions.length]).toEqual(["bookkeeping", "self", 0]);
      expect(c?.vehicles).toEqual(["uav", "ugv"]);
    }
    expect(getCapability("setTimer")?.failureCodes).toEqual(["delay_out_of_range", "timer_limit"]);
    expect(getCapability("cancelTimer")?.failureCodes).toEqual(["timer_not_found"]);
  });
  it("the researcher's injectable commands are a closed set of self-scope actions, not in the minds' manifest", () => {
    expect([...INJECTABLE_COMMANDS]).toEqual(["explore", "goTo", "hold", "land", "takeoff"]);
    for (const name of INJECTABLE_COMMANDS) {
      expect(getCapability(name)?.kind, name).toBe("action");
      expect(isInjectable(name)).toBe(true);
    }
    for (const name of ["returnToBase", "setTimer", "cancelTimer", "nope", ""]) expect(isInjectable(name), name).toBe(false);
    expect(JSON.stringify(capabilityManifest())).not.toContain("injectable");
  });
});
