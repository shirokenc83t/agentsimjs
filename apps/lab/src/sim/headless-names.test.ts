import { describe, expect, it } from "vitest";
import { baseLabel, headlessButton, headlessTip, rerunLabel } from "./headless-names.ts";

describe("what a headless re-run is called", () => {
  it("names the run it re-runs and how many commands it applies again, and never chains the marks", () => {
    expect(rerunLabel("F1 demo", "run-000001", 4)).toBe("F1 demo · re-run of run-000001 · 4 commands re-applied");
    expect(rerunLabel("F1 demo", "run-000001", 1)).toBe("F1 demo · re-run of run-000001 · 1 command re-applied");
    expect(rerunLabel("F1 demo · re-run of run-000001 · 4 commands re-applied", "run-000003", 2)).toBe("F1 demo · re-run of run-000003 · 2 commands re-applied");
    expect(baseLabel("F1 demo · re-run of run-000001 · 4 commands re-applied")).toBe("F1 demo");
    expect(baseLabel("F1 demo")).toBe("F1 demo");
  });
  it("the button says re-run only when there are commands to re-apply, and the tip says what is the same", () => {
    expect(headlessButton(0)).toBe("Run headless");
    expect(headlessButton(3)).toBe("Re-run headless");
    expect(headlessTip(3, "run-000001")).toContain("the 3 commands of run-000001");
    expect(headlessTip(0, "run-000001")).toContain("No commands to re-apply");
  });
});
