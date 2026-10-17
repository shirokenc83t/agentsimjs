import { describe, expect, it } from "vitest";
import { RESTORE_API } from "./restore-api.ts";
import { checkRestore } from "./restore-check.ts";
import { SHORT_RECIPES } from "./restore-recipes.ts";

// F3a M1, T-003: restoring at tick N and running to E gives what the uninterrupted run gives (plan M1, ADR-0035
// addition of 2026-10-17, item 8): the state hash at every tick, the pending decision requests, the trace records and
// timer events after N, and byte-identical snapshots. Six kinds of run, several N each. The long versions are in
// restore.determinism.test.ts. Written before the restore code: skipped until T-006 composes `snapshotRun` and
// `restoreRun` (T-006 turns `restoreIt` into `it`). The PlanningService-only restore tests of F2b stay as they are.
const restoreIt = it;

describe("restore acceptance, short runs (F3a M1, T-003, on the composition of T-006)", () => {
  for (const recipe of SHORT_RECIPES) {
    restoreIt(`${recipe.name}: restoring at ${recipe.snapshotTicks.join(", ")} and running to ${recipe.endTick} matches the uninterrupted run`, async () => {
      const report = await checkRestore(recipe, RESTORE_API);
      expect(report.mismatches).toEqual([]);
    }, 120_000);
  }
});
