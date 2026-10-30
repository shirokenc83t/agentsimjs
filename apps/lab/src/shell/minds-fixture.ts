import type { SimMindsMessage } from "@agentsim/core";

// The states of the System 2 minds the designer's board LimitsPause draws, as the worker would post them: the numbers agree across the board (decision 31, the 82 % warning at 33.8 s, and the pause at
// 40 912 tokens and 14 calls, tick 342). The tests use them, and the test probe can put one in the store for the review captures (it changes nothing in any run).

const BASE: SimMindsMessage["agents"][number] = {
  agentId: "uav-001",
  profile: "scout-llm v3",
  provider: "local-ollama",
  model: "qwen2.5:7b",
  calls: 14,
  tokens: 40_912,
  costUsd: 0,
  limits: { calls: 20, tokens: 40_000, costUsd: 0.05 },
  pricesKnown: false,
  warnings: [],
};

export function mindsFixture(state: "quiet" | "waiting" | "waiting-several" | "warning" | "paused" | "raised"): SimMindsMessage {
  const head = { type: "minds" as const, runId: "run-000012", mode: "live" as const, queue: { active: 0, waiting: 0 } };
  switch (state) {
    case "quiet":
      return { ...head, tick: 120, waiting: 0, agents: [{ ...BASE, calls: 4, tokens: 11_200 }] };
    case "waiting":
      return { ...head, tick: 301, waiting: 1, queue: { active: 1, waiting: 0 }, agents: [{ ...BASE, calls: 9, tokens: 24_300 }] };
    case "waiting-several":
      return { ...head, tick: 301, waiting: 3, queue: { active: 1, waiting: 2 }, agents: [{ ...BASE, calls: 9, tokens: 24_300 }, { ...BASE, agentId: "uav-002", calls: 6, tokens: 15_000 }, { ...BASE, agentId: "ugv-001", calls: 7, tokens: 18_100 }] };
    case "warning":
      return { ...head, tick: 338, waiting: 0, agents: [{ ...BASE, calls: 13, tokens: 32_818, warnings: [{ limit: "tokens", pct: 82 }] }] };
    case "paused":
      return { ...head, tick: 342, waiting: 0, agents: [{ ...BASE, warnings: [{ limit: "tokens", pct: 82 }] }], pausedAt: { agentId: "uav-001", limit: "tokens", used: 40_912, max: 40_000, tick: 342 } };
    case "raised":
      return { ...head, tick: 350, waiting: 0, agents: [{ ...BASE, limits: { calls: 20, tokens: 80_000, costUsd: 0.05 } }] };
  }
}
