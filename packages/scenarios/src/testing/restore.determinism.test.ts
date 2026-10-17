import { describe, expect, it } from "vitest";
import { RESTORE_API } from "./restore-api.ts";
import { checkRestore } from "./restore-check.ts";
import { LONG_RECIPES } from "./restore-recipes.ts";

// F3a M1: the restore acceptance on long runs (1,000+ ticks, and 20 agents), in the determinism project
// (`pnpm test:determinism`).
const restoreIt = it;

describe("restore acceptance, long runs (F3a M1, on the whole-run composition)", () => {
  for (const recipe of LONG_RECIPES) {
    restoreIt(`${recipe.name}: restoring at ${recipe.snapshotTicks.join(", ")} and running to ${recipe.endTick} matches the uninterrupted run`, async () => {
      const report = await checkRestore(recipe, RESTORE_API);
      expect(report.mismatches).toEqual([]);
    }, 900_000);
  }
});
