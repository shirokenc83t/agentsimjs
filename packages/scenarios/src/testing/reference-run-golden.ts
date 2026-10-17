import { expect } from "vitest";
import golden from "./reference-run.golden.json";
import { REFERENCE_TICKS, runReference } from "./reference-run.ts";

/**
 * Shared assertion for the Node and cross-engine (Chromium, Firefox) runs of the F1 reference scenario:
 * the full stack (planner, runtime, reflexes, drive models, battery, script brains) reproduces the state
 * hash every 100 ticks. Regenerate with `UPDATE_GOLDEN=1 pnpm exec vitest run --project node tools/golden`.
 */
export async function expectReferenceRunMatchesGolden(): Promise<void> {
  expect(golden.ticks).toBe(REFERENCE_TICKS);
  const { checkpoints } = await runReference();
  expect(checkpoints).toEqual(golden.checkpoints);
}
