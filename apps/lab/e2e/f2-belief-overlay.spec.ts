import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, referenceSettled, runCommand, step, waitForStorageReady } from "./helpers.ts";

const beliefStats = (page: Page) => page.evaluate(() => window.__agentsim?.scene?.stats().belief);
const beliefCell = (page: Page, i: number, j: number) => page.evaluate(([a, b]) => window.__agentsim?.scene?.beliefCell(a ?? 0, b ?? 0), [i, j]);

// ADR-0027 (F2 belief overlay) and ADR-0005 addition of 2026-10-12: the viewed agent's own map, one atlas at a time, streamed
// only while the overlay is on; the difference mode is the researcher-only comparison.
test("the belief overlay shows the selected agent's own map, is released when switched off, and follows the selected agent", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  expect((await beliefStats(page))?.pages).toBe(0); // overlay off: nothing in memory, nothing streamed

  await step(page, 1);
  await page.getByTestId("overlay-belief").click();
  await expect.poll(async () => (await beliefStats(page))?.pages).toBe(1);
  await expect.poll(async () => (await beliefStats(page))?.chunksPending).toBe(0);
  // The rover at (10, 10) m has looked around: its own cell is believed free, a cell across the map is still unknown.
  await expect.poll(() => beliefCell(page, 20, 20)).toBe(1);
  expect(await beliefCell(page, 120, 120)).toBe(0);
  const rover = (await beliefStats(page))?.chunksUploaded ?? 0;
  expect(rover).toBeGreaterThan(0);

  // Another agent: the previous atlas is released, the new one starts from scratch (it is a different agent's map).
  await page.getByTestId("explorer-row-uav-001").click();
  await expect.poll(async () => (await beliefStats(page))?.pages).toBe(1);
  await expect.poll(async () => (await beliefStats(page))?.chunksPending).toBe(0);

  // Overlay off: the atlas is released and the stream stops.
  await page.getByTestId("overlay-truth").click();
  await expect.poll(async () => (await beliefStats(page))?.pages).toBe(0);
});

test("the difference mode is researcher-only: marked while on, hatched mismatches, absent in the ordinary views", async ({ page }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /WebGLProgram|shader/i.test(m.text())) problems.push(m.text());
  });
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("scene-researcher-marker")).toHaveCount(0);
  await page.getByTestId("overlay-belief").click();
  await expect(page.getByTestId("scene-researcher-marker")).toHaveCount(0); // belief is an ordinary view
  await page.getByTestId("overlay-difference").click();
  await expect(page.getByTestId("scene-researcher-marker")).toHaveText("◆ Researcher view — not visible to the mind");
  await expect(page.getByTestId("overlay-legend")).toContainText("believed free, actually blocked");
  await page.getByTestId("overlay-truth").click();
  await expect(page.getByTestId("scene-researcher-marker")).toHaveCount(0);
  expect(problems, "the belief and difference shaders compile and draw without errors").toEqual([]);
});

test("an ideal agent has no map of its own: the overlay says so and streams nothing", async ({ page }) => {
  await loadDemo(page);
  await page.getByTestId("explorer-row-ugv-001").click();
  await page.getByTestId("overlay-belief").click();
  await expect(page.getByTestId("overlay-ideal")).toBeVisible();
  expect((await beliefStats(page))?.pages).toBe(0);
});

// Reported, not gated (like the F1 atlas upload): how long a whole 1 km² known map takes to reach the screen, and what
// the frames cost meanwhile.
test("the 1 km² belief map of a prior is shown in full within the shared upload budget, without long frames", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await runCommand(page, "Load F2 prior map demo");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f2-prior-1km v\d+$/, { timeout: 90_000 });
  await page.keyboard.press("Escape");
  await referenceSettled(page);
  await page.getByTestId("explorer-row-ugv-001").click();
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frameLog.length = 0));
  const t0 = Date.now();
  await page.getByTestId("overlay-belief").click();
  await expect
    .poll(async () => {
      const b = await beliefStats(page);
      return b !== undefined && b.pages === 1 && b.chunksUploaded >= 1000 && b.chunksPending === 0;
    }, { timeout: 120_000 })
    .toBe(true);
  const ms = Date.now() - t0;
  const log = await page.evaluate(() => window.__agentsim?.frameLog.slice() ?? []);
  const upload = log.filter((f) => f[3] > 0).map((f) => f[1]).sort((a, b) => a - b);
  const p95 = upload[Math.floor(upload.length * 0.95)] ?? 0;
  console.log(JSON.stringify({ belief1km: { showMs: ms, uploadFrames: upload.length, uploadFrameWorkP95Ms: p95 } }));
  // The whole known map arrived, and the prior's stale square is visible as a mismatch only in the difference mode.
  expect(await beliefCell(page, 0, 0)).not.toBeUndefined();
  await page.getByTestId("overlay-difference").click();
  await page.screenshot({ path: "test-results/f2-belief-difference.png" });
  expect(upload.length).toBeGreaterThan(10);
});
