import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, step } from "./helpers.ts";

// ADR-0005 addition of 2026-10-12: beliefs-versus-truth is a researcher-only view, visibly apart from what the mind
// receives, streamed only while the section is shown, and never sent back.
const pct = async (page: Page, id: string) => Number(((await page.getByTestId(id).textContent()) ?? "").match(/[\d.]+/)?.[0]);

test("the researcher section is marked, separate from the mind view, and shows the map converging while the agent explores", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  const mind = page.getByTestId("inspector-mind-view");
  const researcher = page.getByTestId("inspector-researcher");
  await expect(researcher.getByTestId("researcher-banner")).toHaveText("◆ Researcher view — not visible to the mind");
  // Two different sections: what the mind receives holds no comparison with the ground truth, and the researcher
  // section is not inside it.
  await expect(mind.getByTestId("researcher-banner")).toHaveCount(0);
  await expect(mind.getByTestId("researcher-unknown")).toHaveCount(0);
  expect(await mind.textContent()).not.toMatch(/ground truth|phantom|wrong:/i);
  expect(await page.getByTestId("mind-request-json").textContent()).not.toMatch(/correctPct|phantomPct|reachableCells/);

  // At tick 0 the rover knows next to nothing; exploring improves the map and never makes it wrong.
  await expect(researcher.getByTestId("researcher-correct")).toBeVisible();
  const before = await pct(page, "researcher-unknown");
  expect(before).toBeGreaterThan(50);
  await page.getByTestId("command-explore").click();
  await step(page, 3);
  await expect.poll(() => pct(page, "researcher-unknown")).toBeLessThan(before);
  expect(await pct(page, "researcher-phantom")).toBe(0);
  await expect(page.getByTestId("researcher-falsefree")).toContainText("0 cells");
});

test("an ideal agent has nothing to compare; collapsing the section stops its stream", async ({ page }) => {
  test.setTimeout(60_000);
  await loadDemo(page);
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("researcher-ideal")).toContainText("ideal");
  await page.locator('[data-testid="inspector-researcher"] > summary').click();
  await expect(page.getByTestId("inspector-researcher")).not.toHaveAttribute("open", "");
});
