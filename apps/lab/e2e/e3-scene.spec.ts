import { expect, test, type Page } from "@playwright/test";
import { waitForStorageReady } from "./helpers.ts";

async function loadDemo(page: Page) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  await page.keyboard.press("Escape");
}

// The ground-truth atlas counters (the belief overlay has its own, under `belief`: nothing in it while the overlay is off).
const sceneStats = (page: Page) => page.evaluate(() => { const s = window.__agentsim?.scene?.stats(); return s && { pages: s.pages, chunksUploaded: s.chunksUploaded, chunksPending: s.chunksPending }; });

// F1 e3 (ADR-0027): the grid is drawn from atlas pages updated per chunk; agents carry ID labels; a click
// selects an agent or a cell through the shared UI context (ADR-0016).
test("the demo grid is drawn from one atlas page, agents are labelled, and clicks select agents and cells", async ({ page }) => {
  await loadDemo(page);
  await expect(page.getByTestId("scene-toolbar")).toBeVisible();
  // 128 × 128 cells, chunks of 32: 16 chunks on one page, all uploaded within the per-frame budget.
  await expect.poll(() => sceneStats(page)).toEqual({ pages: 1, chunksUploaded: 16, chunksPending: 0 });

  // Labels are short on the map (g01, a01); the whole ID is in the tooltip and the Explorer.
  for (const [id, short] of [["uav-001", "a01"], ["ugv-001", "g01"], ["ugv-002", "g02"]] as const) await expect(page.locator(`.agent-label[data-agent="${id}"]`)).toContainText(short);

  await page.getByTestId("view-height").click();
  await page.getByTestId("wb-collapse-legend").click(); // the legend is a window of its own
  await expect(page.getByText("occupied, unknown height")).toBeVisible();
  await page.getByTestId("view-occupancy").click();

  const rover = await page.evaluate(() => window.__agentsim?.scene?.screenOf("ugv-001"));
  expect(rover).toBeDefined();
  await page.mouse.click(rover?.x ?? 0, rover?.y ?? 0);
  await expect.poll(() => page.evaluate(() => window.__agentsim?.selection?.())).toEqual({ kind: "agent", id: "ugv-001" });

  // A ground point away from agents selects its cell (0.5 m cells): (40.2, 30.2) m → cell (80, 60).
  const ground = await page.evaluate(() => window.__agentsim?.scene?.screenOfGround(40.2, 30.2));
  await page.mouse.click(ground?.x ?? 0, ground?.y ?? 0);
  await expect.poll(() => page.evaluate(() => window.__agentsim?.selection?.())).toEqual({ kind: "cell", id: "80,60" });
});
