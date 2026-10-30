import type { SimMindsMessage } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { mindsFixture } from "./minds-fixture.ts";
import { allowsWords, kilo, pctOf, raisePresets, rateWords, spaced, tileAgent, usedWords, validRaise, worstLimit, type AgentMinds } from "./minds-limits.ts";

// The words of the limit notice and the raise dialog (the boards: 40 912 of 40 000 tokens, 14 calls, about 2 900 tokens a call).

const agent = (over: Partial<AgentMinds> = {}): AgentMinds => ({ ...(mindsFixture("paused").agents[0] as AgentMinds), warnings: [], ...over });

describe("the limit words", () => {
  it("spaces thousands and shortens tokens", () => {
    expect(spaced(40912)).toBe("40 912");
    expect(spaced(999)).toBe("999");
    expect(kilo(40_912)).toBe("40.9k");
    expect(kilo(820)).toBe("820");
  });

  it("gives the share of each limit, and none for a cost without prices; the worst limit is the one closest to its end", () => {
    const a = agent();
    expect(pctOf(a, "tokens")).toBe(102);
    expect(pctOf(a, "calls")).toBe(70);
    expect(pctOf(a, "costUsd")).toBe(0);
    expect(worstLimit(a)).toEqual({ limit: "tokens", pct: 102 });
    expect(pctOf(agent({ pricesKnown: true, costUsd: 0.04 }), "costUsd")).toBe(80);
    expect(worstLimit(agent({ tokens: 100 }))).toEqual({ limit: "calls", pct: 70 });
  });

  it("follows the agent that paused the run, else the one closest to a limit", () => {
    const a = agent();
    const b = agent({ agentId: "uav-002", calls: 19, tokens: 100 });
    const m = (extra: Partial<SimMindsMessage> = {}): SimMindsMessage => ({ ...mindsFixture("quiet"), agents: [a, b], ...extra });
    expect(tileAgent(m())?.agentId).toBe("uav-001"); // 102 % of the tokens beats 95 % of the calls
    expect(tileAgent(m({ pausedAt: { agentId: "uav-002", limit: "calls", used: 20, max: 20, tick: 1 } }))?.agentId).toBe("uav-002");
  });

  it("writes what was used of a limit, the presets of a raise, the rate, and what a raise allows at that rate", () => {
    expect(usedWords(40_912, 40_000, "tokens")).toBe("40 912 of 40 000 (102 %)");
    expect(usedWords(0.0512, 0.05, "costUsd")).toBe("0.0512 of 0.0500 (102 %)");
    expect(raisePresets("tokens", 40_000)).toEqual([{ label: "+50 %", value: 60_000 }, { label: "×2", value: 80_000 }, { label: "×5", value: 200_000 }]);
    expect(raisePresets("costUsd", 0.05).map((p) => p.value)).toEqual([0.08, 0.1, 0.25]);
    expect(rateWords(agent())).toBe("about 2 900 tokens a call");
    expect(allowsWords(agent(), "tokens", 80_000)).toBe("about 13 more calls at the current rate");
    expect(allowsWords(agent({ calls: 20, tokens: 0 }), "calls", 60)).toBe("40 more calls");
    expect(allowsWords(agent({ calls: 0, tokens: 0 }), "tokens", 80_000)).toContain("no rate yet");
  });

  it("accepts a raise only above the limit in force", () => {
    expect(validRaise(80_000, 40_000)).toBe(true);
    expect(validRaise(40_000, 40_000)).toBe(false);
    expect(validRaise(Number.NaN, 40_000)).toBe(false);
  });
});
