import { DEFAULT_PROMPT_TEMPLATE, MIND_DEFAULTS } from "@agentsim/minds";
import type { RunConfigDocument } from "@agentsim/scenarios";
import { describe, expect, it } from "vitest";
import { estimate, estimateWords, missionPoints, REQUEST_TOKENS, runModeOf, s2Of, withRunMode, withS2 } from "./minds-model.ts";

// The model of the minds table (F4 M4, T-125): the entry of an agent and its removal, the run mode written by omission, and the estimate of calls and tokens with the formula on fixtures.

const BASE: RunConfigDocument = { schemaVersion: 0, scenario: { id: "f2-inspect", version: 1 } } as RunConfigDocument;
const ENTRY = { profile: { id: "scout-llm", version: 3 }, mission: "Inspect P1." };

describe("the entry of an agent", () => {
  it("sets an s2 entry for an agent, takes it away again, and drops an empty minds section", () => {
    const set = withS2(BASE, "uav-001", ENTRY as never);
    expect(s2Of(set, "uav-001")).toEqual(ENTRY);
    expect(withS2(set, "uav-001", undefined)).toEqual(BASE);
    const two = withS2(withS2(BASE, "a", ENTRY as never), "b", ENTRY as never);
    expect(Object.keys(two.minds?.byAgent ?? {})).toEqual(["a", "b"]);
    expect(Object.keys(withS2(two, "a", undefined).minds?.byAgent ?? {})).toEqual(["b"]);
  });

  it("writes the run mode by omission for live (the document of a run that never named one is unchanged) and reads it back", () => {
    expect(withRunMode(BASE, "live")).toEqual(BASE);
    expect(withRunMode(BASE, "replay-strict").mindsRunMode).toBe("replay-strict");
    expect(runModeOf(withRunMode(BASE, "replay-then-live"))).toBe("replay-then-live");
    expect(runModeOf(BASE)).toBe("live");
    expect(withRunMode(withRunMode(BASE, "replay-strict"), "live")).toEqual(BASE);
  });
});

describe("the estimate of a run's calls and tokens", () => {
  const MISSION = "Inspect P1 (20, 40), P2 (50, 20) and P3 (70, 55), in the order you think cheapest, then return to base and land.";
  it("counts the places a mission names: the coordinate pairs and the base", () => {
    expect(missionPoints(MISSION)).toBe(4);
    expect(missionPoints("Wait for events.")).toBe(0);
    expect(missionPoints("Go to (1.5, -2) then (3,4).")).toBe(2);
    expect(missionPoints("Hold, then land.")).toBe(1);
  });

  it("is 2 to 4 calls for each place and one to finish, at the size of the prompt, against the limits", () => {
    const limits = { ...MIND_DEFAULTS.limits, tokens: 60_000 };
    const e = estimate({ mission: MISSION, effective: { limits }, template: DEFAULT_PROMPT_TEMPLATE });
    expect(e.points).toBe(4);
    expect(e.calls).toEqual([9, 17]);
    const perCall = Math.ceil(DEFAULT_PROMPT_TEMPLATE.system.length / 4) + Math.ceil(MISSION.length / 4) + REQUEST_TOKENS;
    expect(e.perCallTokens).toBe(perCall);
    expect(e.tokens).toEqual([9 * perCall, 17 * perCall]);
    expect(e.costUsd).toBeUndefined();
    const w = estimateWords(e);
    expect(w.calls).toBe("9–17 of 20");
    expect(w.tokens).toMatch(/^\d+k–\d+k of 60k$/);
    expect(w.cost).toBe("no prices");
    expect(w.basis).toContain("It is a range, not a promise; the run pauses at a limit.");
    expect(w.overLimit).toBe(false);
  });

  it("says it is over a limit when the upper end is, and gives a cost range only with prices", () => {
    const e = estimate({ mission: MISSION, effective: { limits: { ...MIND_DEFAULTS.limits, calls: 12 } }, template: DEFAULT_PROMPT_TEMPLATE, prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
    expect(e.costUsd?.[0]).toBeGreaterThan(0);
    expect(e.costUsd?.[1]).toBeGreaterThan(e.costUsd?.[0] ?? 0);
    expect(estimateWords(e).overLimit).toBe(true);
    expect(estimateWords(e).cost).toMatch(/^0\.\d{4}–0\.\d{4} of 0\.05 USD$/);
  });
});
