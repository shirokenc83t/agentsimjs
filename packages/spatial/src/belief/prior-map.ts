import type { BeliefMap } from "./belief-map.ts";

/** Prior `knowledge` codes (ADR-0025 addition of 2026-10-09). */
export const PRIOR_UNKNOWN = 0;
export const PRIOR_FREE = 1;
export const PRIOR_OCCUPIED = 2;

/** Largest starting magnitude of a prior cell (confidence 1), below the ±100 clamp (ADR-0028 addition of 2026-10-09). */
export const PRIOR_MAX_LOGODDS = 60;

/**
 * A prior map from the scenario, decoded once at load and shared read-only by the agents that start from it.
 * Dense, row-major (`j · sizeX + i`). Scenario data, not ground truth: it may be wrong or stale on purpose.
 */
export interface PriorMap {
  readonly id: string;
  readonly sizeX: number;
  readonly sizeY: number;
  /** In (0, 1]: known cells start at ±round(60 × confidence). */
  readonly confidence: number;
  /** 0 = unknown, 1 = free, 2 = occupied. */
  readonly knowledge: Uint8Array;
  /** World-layer semantics where `knowledge` is not 0: ground height on free cells, obstacle top on occupied ones (0 = unknown). */
  readonly heightDm: Uint16Array | undefined;
  /** World-layer semantics where `knowledge` is not 0 (10 = nominal, 0 = impassable for ground vehicles). */
  readonly terrainCost: Uint8Array | undefined;
}

export function priorLogOdds(confidence: number): number {
  return Math.round(PRIOR_MAX_LOGODDS * confidence);
}

/** Starts a belief map from a prior: known cells at ±round(60 × confidence), occupied cells with a known top at that height. */
export function applyPrior(b: BeliefMap, p: PriorMap): void {
  if (p.sizeX !== b.sizeX || p.sizeY !== b.sizeY) throw new RangeError(`prior ${p.id} is ${p.sizeX} × ${p.sizeY}, the map ${b.sizeX} × ${b.sizeY}`);
  const l = priorLogOdds(p.confidence);
  for (let j = 0; j < p.sizeY; j++) {
    for (let i = 0; i < p.sizeX; i++) {
      const k = j * p.sizeX + i;
      const s = p.knowledge[k] ?? PRIOR_UNKNOWN;
      if (s === PRIOR_FREE) b.setPrior(i, j, -l);
      else if (s === PRIOR_OCCUPIED) {
        b.setPrior(i, j, l);
        const h = p.heightDm?.[k] ?? 0;
        if (h > 0) b.setPriorHeightDm(i, j, h);
      }
    }
  }
}
