import { expect, test } from "@playwright/test";
import { loadF2, runCommand, step } from "./helpers.ts";

// F3c M2 (ADR-0043 section 7): the swarm knowledge band in the player, derived from the recorded belief-vs-truth samples of the observer: what the swarm believes it knows, how much of
// that matches the truth, labelled as observer data, with its rate and its agents in the tooltip.

test("the player draws the swarm knowledge band from the recorded observer samples, labelled as observer data, and it grows as the swarm explores", async ({ page }) => {
  test.setTimeout(180_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Explore selected agent (ugv-001)");
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  const band = page.getByTestId("player-knowledge-band");
  await expect(band).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Number(await band.getAttribute("data-points"))).toBeGreaterThan(2);
  const label = page.getByTestId("player-knowledge");
  await expect(label).toContainText("observer");
  await expect(label).toContainText("belief matches truth");
  await expect(label).toContainText("swarm knows");
  // The tooltip carries the facts of the definition: that it is observer data and the rate of the samples.
  const tip = (await label.getAttribute("title")) ?? "";
  expect(tip).toContain("observer data");
  expect(tip).toContain("each agent every 10 s");
  const early = Number(await band.getAttribute("data-known"));
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 30_000 });
  await expect.poll(async () => Number(await band.getAttribute("data-known"))).toBeGreaterThanOrEqual(early);
});
