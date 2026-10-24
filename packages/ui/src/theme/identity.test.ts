import { describe, expect, it } from "vitest";
import { IDENTITY_COUNT, identityOf, shortLabel } from "./identity.ts";

describe("agent identity", () => {
  it("24 distinct identities, a colour and a marker style, in order of the run's agents", () => {
    expect(IDENTITY_COUNT).toBe(24);
    const all = Array.from({ length: IDENTITY_COUNT }, (_, i) => identityOf(i));
    expect(new Set(all.map((x) => `${x.colorIndex}/${x.style}`)).size).toBe(24);
    expect(all.slice(0, 8).map((x) => x.style)).toEqual(Array(8).fill("solid"));
    expect(all.slice(8, 16).every((x) => x.style === "outline")).toBe(true);
    expect(all.slice(16).every((x) => x.style === "dashed")).toBe(true);
    // The first eight take the eight colours; the next eight take them again in the next style.
    expect(all.slice(0, 8).map((x) => x.colorIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(all[8]?.colorIndex).toBe(0);
  });

  it("past 24 agents the identities repeat, and no index breaks it", () => {
    expect(identityOf(24)).toEqual(identityOf(0));
    expect(identityOf(-1)).toEqual(identityOf(23));
    expect(identityOf(2.7)).toEqual(identityOf(2));
  });

  it("the short label is g for a ground vehicle and a for an aerial one, with two digits at least", () => {
    expect(shortLabel("ugv-007")).toBe("g07");
    expect(shortLabel("uav-007")).toBe("a07");
    expect(shortLabel("ugv-001")).toBe("g01");
    expect(shortLabel("ugv-112")).toBe("g112");
    expect(shortLabel("ugv-0")).toBe("g00");
    expect(shortLabel("rover")).toBe("rover");
    expect(shortLabel("a-very-long-name")).toBe("a-ver…");
  });
});
