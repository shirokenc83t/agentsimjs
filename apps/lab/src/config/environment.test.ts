import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "./environment.ts";

describe("environment config", () => {
  it("selects local adapters by default and fails fast for hosted until FB", () => {
    expect(resolveEnvironment(undefined).mode).toBe("local");
    expect(resolveEnvironment("local").mode).toBe("local");
    expect(() => resolveEnvironment("hosted")).toThrow(/phase FB/);
    expect(() => resolveEnvironment("cloud")).toThrow(/Unknown environment/);
  });
});
