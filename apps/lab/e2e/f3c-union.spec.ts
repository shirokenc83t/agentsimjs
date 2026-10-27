import { expect, test, type Page } from "@playwright/test";
import { loadF2, runCommand, step } from "./helpers.ts";

// F3c M3, T-101: the union of the cells any agent knows, from the recorded belief keyframes and deltas, in the band. Where the run has it the label says "swarm knows" (the union) and the
// tooltip says so; before it the mean with its label. The cost is measured and printed (UNION lines) for the 20-agent reference run, live, in replay and headless.

const kind = (page: Page) => page.getByTestId("player-knowledge").getAttribute("data-kind");

test("20 agents: the union appears in the live band, in the replay band and in the headless monitor, with its cost measured", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "agents");
  await page.getByTestId("explorer-row-ugv-003").click();
  await runCommand(page, "Explore selected agent (ugv-003)");
  const t0 = Date.now();
  await step(page, 6);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 30_000 });
  await expect(page.getByTestId("player-knowledge-band")).toHaveAttribute("data-kind", "union", { timeout: 120_000 });
  const live = await page.getByTestId("player-knowledge-band").evaluate((el) => ({ ms: el.getAttribute("data-union-ms"), reads: el.getAttribute("data-union-reads") }));
  const liveWall = Date.now() - t0;
  console.log(`UNION live (60 s of 20 agents): ${live.reads} belief maps rebuilt, ${live.ms} ms in the worker, ${liveWall} ms from the first step to the union shown`);
  await expect(page.getByTestId("player-knowledge")).toContainText("swarm knows");
  const tip = (await page.getByTestId("player-knowledge").getAttribute("title")) ?? "";
  expect(tip).toContain("the union of what its agents know");
  expect(await kind(page)).toBe("union");

  // Replay: the same run scrubbed from storage (the cache holds the union already computed: the second panel does not read again).
  await page.getByTestId("scrub-back").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player-knowledge-band")).toHaveAttribute("data-kind", "union", { timeout: 60_000 });
  const replay = await page.getByTestId("player-knowledge-band").evaluate((el) => ({ ms: el.getAttribute("data-union-ms"), reads: el.getAttribute("data-union-reads") }));
  console.log(`UNION replay: ${replay.reads} reads, ${replay.ms} ms (the same run: nothing read again)`);
  await page.getByTestId("replay-close").click();

  // Headless: a new run of the same scene, its monitor.
  await runCommand(page, "Run headless");
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
  const h0 = Date.now();
  await expect(page.getByTestId("hm-knowledge")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("hm-knowledge").getByTestId("player-knowledge-band")).toHaveAttribute("data-kind", "union", { timeout: 120_000 });
  const head = await page.getByTestId("hm-knowledge").getByTestId("player-knowledge-band").evaluate((el) => ({ ms: el.getAttribute("data-union-ms"), reads: el.getAttribute("data-union-reads") }));
  console.log(`UNION headless (60 s of 20 agents): ${head.reads} reads, ${head.ms} ms in the worker, ${Date.now() - h0} ms from done to the union shown`);
});
