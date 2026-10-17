import { expect, test, type Page } from "@playwright/test";
import { loadF2, step } from "./helpers.ts";

const pct = async (page: Page, id: string) => Number(((await page.getByTestId(id).textContent()) ?? "").match(/[\d.]+/)?.[0]);
const frontierCounts = (page: Page) => page.evaluate(() => window.__agentsim?.scene?.overlays());

/**
 * Explores the F2 discovery map with the rover, starting after `warmupHundreds` × 100 ticks, until the action ends; checks the
 * ending, the empty frontier overlay and the converged map (researcher view).
 */
async function exploreUntilConverged(page: Page, warmupHundreds: number) {
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await page.getByTestId("overlay-frontiers").click();
  const before = await pct(page, "researcher-unknown");
  expect(before).toBeGreaterThan(90); // at tick 0 the rover knows nothing
  if (warmupHundreds > 0) await step(page, warmupHundreds);

  await page.getByTestId("command-explore").click();
  await step(page, 1);
  await expect.poll(async () => (await frontierCounts(page))?.frontiers).toBeGreaterThan(0);
  const label = page.getByTestId("inspector-action-label");
  for (let k = 0; k < 40 && !/explore · (succeeded|failed)/.test((await label.textContent()) ?? ""); k++) await step(page, 1);
  await expect(label).toContainText("explore · succeeded");

  // Why it ended, from the trace: nothing reachable left to discover.
  const end = await page.evaluate(() =>
    (window.__agentsim?.records?.() ?? []).find((r) => {
      const x = r as { kind?: string; agentId?: string; payload?: { op?: string; name?: string; status?: string } };
      return x.kind === "action" && x.agentId === "ugv-001" && x.payload?.op === "end" && x.payload.name === "explore";
    }) as { payload: { result?: { reason?: string } } } | undefined,
  );
  expect(["frontier_exhausted", "region_explored"]).toContain(end?.payload.result?.reason);

  // The frontier overlay is empty (a group marked unreachable may remain: it is skipped, not a target).
  await expect
    .poll(async () => {
      const c = await frontierCounts(page);
      return c ? c.frontiers - c.markedFrontiers : -1;
    })
    .toBe(0);

  // The researcher view: what could be reached is known, and nothing is wrong.
  const unknown = await pct(page, "researcher-unknown");
  expect(unknown).toBeLessThan(before);
  expect(unknown).toBeLessThan(10);
  expect(await pct(page, "researcher-phantom")).toBe(0);
  await expect(page.getByTestId("researcher-falsefree")).toContainText("0 cells");
  console.log(JSON.stringify({ exploreConverged: { warmupTicks: warmupHundreds * 100, unknownBeforePct: before, unknownAfterPct: unknown, correctPct: await pct(page, "researcher-correct") } }));
}

// ROADMAP F2 acceptance: a UGV explores an unknown area with lidar until frontiers are exhausted, and the belief map
// converges towards the ground truth (measured by the researcher view).
test("explore the bounded F2 map from tick 0: the frontier overlay empties, the action ends frontier_exhausted, and the researcher view shows the map converged", async ({ page }) => {
  test.setTimeout(240_000);
  await exploreUntilConverged(page, 0);
});

// The tick-101 case: started later, the rover used to stop inside its own planning band beside the box wall and fail
// `kinematically_infeasible`; the escape rule (ADR-0033 addition of 2026-10-12) gets it out and explore continues.
test("explore started at tick 101 gets out of the planning band beside the wall and converges the same way", async ({ page }) => {
  test.setTimeout(240_000);
  await exploreUntilConverged(page, 1);
  const escapes = await page.evaluate(
    () => (window.__agentsim?.records?.() ?? []).filter((r) => (r as { payload?: { op?: string; kind?: string } }).payload?.op === "recovery" && (r as { payload: { kind?: string } }).payload.kind === "escape").length,
  );
  expect(escapes, "the escape is traced").toBeGreaterThan(0);
});
