import type { LoadedScenario } from "../load.ts";

/**
 * Counts reads of ground-truth cell content (the grid's content methods and its layers' `get`) while `during`
 * runs: the instrument of the architecture tests (belief boundary, action starts, request building). Map size and
 * mission data (zones, limits) are not content and are not counted.
 */
export function watchTruth(l: Pick<LoadedScenario, "grid">) {
  let on = false;
  const hits: string[] = [];
  const g = l.grid as unknown as Record<string, unknown>;
  for (const name of ["isBlocked", "terrainAt", "groundHeightM", "obstacleTopM", "isFreeForGround", "isFreeForAir", "occupancyDense", "classifyChunk", "isUnknown"]) {
    const f = g[name] as ((...a: unknown[]) => unknown) | undefined;
    if (!f) continue;
    g[name] = (...a: unknown[]) => {
      if (on) hits.push(name);
      return f.apply(l.grid, a);
    };
  }
  for (const layer of ["occupancy", "terrainCost", "heightDm"] as const) {
    const obj = l.grid[layer] as unknown as Record<string, unknown>;
    const f = obj["get"] as (...a: unknown[]) => unknown;
    obj["get"] = (...a: unknown[]) => {
      if (on) hits.push(`${layer}.get`);
      return f.apply(l.grid[layer], a);
    };
  }
  return {
    hits,
    during<T>(fn: () => T): T {
      on = true;
      try {
        return fn();
      } finally {
        on = false;
      }
    },
  };
}
