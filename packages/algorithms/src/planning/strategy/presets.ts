import type { PlanningStrategy, StrategyRef } from "./schema.ts";

/**
 * Shipped planning strategies (ADR-0037 §7). Immutable by id and version: a change is a new version, so an old run
 * never changes silently (`presets.golden.json` pins the documents and their content hashes).
 */
export const PLANNING_STRATEGY_PRESETS: readonly PlanningStrategy[] = [
  {
    schemaVersion: 0,
    id: "anytime-weighted",
    version: 1,
    description: "Weighted A* passes with weights 3, 2, 1.5, 1: a first path early, improved while the budget lasts.",
    origin: "human",
    root: { kind: "anytime", weights: [3, 2, 1.5, 1] },
  },
  {
    schemaVersion: 0,
    id: "astar-only",
    version: 1,
    description: "A* alone: the same planner as `algorithm: astar`.",
    origin: "human",
    root: { kind: "algorithm", algorithm: "astar" },
  },
  {
    schemaVersion: 0,
    id: "astar-then-hpa",
    version: 1,
    description: "A* with a small search budget; if it runs out or finds nothing, HPA* takes over.",
    origin: "human",
    root: {
      kind: "fallback",
      stages: [
        { kind: "algorithm", algorithm: "astar", stageBudget: 5000 },
        { kind: "algorithm", algorithm: "hpa" },
      ],
    },
  },
  {
    schemaVersion: 0,
    id: "hpa-only",
    version: 1,
    description: "HPA* alone: the same planner as `algorithm: hpa`.",
    origin: "human",
    root: { kind: "algorithm", algorithm: "hpa" },
  },
  {
    schemaVersion: 0,
    id: "short-astar-long-hpa",
    version: 1,
    description: "A* for trips up to 200 m (straight line), HPA* beyond.",
    origin: "human",
    root: {
      kind: "select",
      branches: [{ when: "dist.m <= 200", then: { kind: "algorithm", algorithm: "astar" } }],
      else: { kind: "algorithm", algorithm: "hpa" },
    },
  },
];

/** A shipped strategy by reference, or `undefined` (never inherited names: `__proto__` and `constructor` are not ids). */
export function presetStrategy(ref: StrategyRef): PlanningStrategy | undefined {
  return PLANNING_STRATEGY_PRESETS.find((p) => p.id === ref.ref && p.version === ref.version);
}
