import { expect, test, type Page } from "@playwright/test";
import { loadDemo, sendTo, step, stepUntilEnded } from "./helpers.ts";

// F1 acceptance from the UI: goTo to a point behind obstacles succeeds along a planned path (both paths drawn);
// a target inside a closed box fails unreachable. The command is a world-scope run input (ADR-0015).
test("send the rover behind the wall from the UI: planned and executed paths drawn, goTo succeeds; the box is unreachable", async ({ page }) => {
  await loadDemo(page);
  await sendTo(page, "ugv-001", 50, 10);
  // Around the wall's north end: ~120 m at 2 m/s, about 600 ticks.
  await stepUntilEnded(page, 15);
  await expect(page.getByTestId("inspector-action-label")).toContainText("goTo · succeeded");
  const paths = await page.evaluate(() => window.__agentsim?.scene?.paths("ugv-001"));
  expect(paths?.planned).toBeGreaterThan(2);
  expect(paths?.executed).toBeGreaterThan(50);
  await expect(page.getByTestId("inspector-plan-expansions")).not.toHaveText("0");

  await sendTo(page, "ugv-001", 50, 45);
  await stepUntilEnded(page, 5);
  await expect(page.getByTestId("inspector-action-label")).toContainText("goTo · failed · unreachable");
  await expect(page.getByTestId("explorer-state-ugv-001")).toContainText("unreachable");
});

/** The rover's executed path after the same commands, as received from the worker. */
async function executedPathAfterRun(page: Page): Promise<readonly number[]> {
  await loadDemo(page);
  await sendTo(page, "ugv-001", 50, 10);
  await step(page, 3);
  return page.evaluate(() => window.__agentsim?.executedPath?.("ugv-001") ?? []);
}

// The executed path comes from simulation state, not rendering: identical points whatever the frame rate.
test("the executed path is identical across runs and render rates (CPU throttled 6×)", async ({ page, browser }) => {
  // Two full runs, one with the CPU throttled 6×: slow by design, especially on CI runners (software GL).
  test.setTimeout(120_000);
  const normal = await executedPathAfterRun(page);
  expect(normal.length / 3).toBeGreaterThan(30); // x, y, z per point

  const ctx = await browser.newContext();
  const slow = await ctx.newPage();
  const cdp = await ctx.newCDPSession(slow);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const throttled = await executedPathAfterRun(slow);
  const fps = await slow.evaluate(() => {
    const f = window.__agentsim?.frameIntervalMs();
    return f && f.mean > 0 ? 1000 / f.mean : 0;
  });
  await ctx.close();
  expect(throttled).toEqual(normal);
  console.log(JSON.stringify({ points: normal.length / 3, throttledFps: Math.round(fps) }));
});
