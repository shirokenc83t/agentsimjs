import { expect, test, type Page } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace, step } from "./helpers.ts";

// F3c M1: a mission composed in the run configuration from the UI for the F2 UAV, run, and followed in the Inspector, Explorer and player; a refused step says why.

async function openRunConfig(page: Page) {
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  return panel;
}

const add = (page: Page, action: string) => page.getByTestId("ms-add").selectOption(action);

/** Runs the mission and returns to the Scene with the UAV selected, paused at tick 0. */
async function runMission(page: Page) {
  await page.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await openWorkspace(page, "scene");
  await page.getByTestId("explorer-row-uav-001").click();
}

test("composes the mission of the F2 UAV from the editor, runs it, and shows each step's state until the end", async ({ page }) => {
  test.setTimeout(180_000);
  await loadF2(page, "discovery");
  const panel = await openRunConfig(page);
  await panel.getByTestId("ms-agent").selectOption("scout");
  await expect(panel.getByTestId("ms-empty")).toBeVisible();
  for (const a of ["takeoff", "goTo", "explore", "returnToBase"]) await add(page, a);
  await panel.getByTestId("ms-arg-1-xM").fill("50");
  await panel.getByTestId("ms-arg-1-yM").fill("20");
  await panel.getByTestId("ms-arg-2-radiusM").fill("15");
  await expect(panel.getByTestId("ms-valid")).toContainText("✓ valid · 4 steps");
  await expect(panel.getByTestId("rc-jump-mission-state")).toContainText("✓ 4");
  await runMission(page);

  const mission = page.getByTestId("inspector-mission");
  await expect(mission).toBeVisible();
  await expect(page.getByTestId("explorer-mission-uav-001")).toContainText("step 0/4");
  await step(page, 1);
  await expect(page.getByTestId("mp-glyph-0")).toHaveText(/[✓▶]/);
  await expect(page.getByTestId("player-mission")).toContainText("uav-001 mission");
  // The rest of the mission is on the map, dashed from the UAV to the point still to go to, and it is gone with the mission.
  await expect.poll(async () => (await page.evaluate(() => window.__agentsim?.scene?.overlays()))?.mission.coarseDashes).toBeGreaterThan(0);

  let sawRunningThird = false;
  for (let k = 0; k < 80 && (await mission.getAttribute("data-status")) !== "done"; k++) {
    if ((await page.getByTestId("mp-row-2").getAttribute("data-state")) === "running") sawRunningThird = true;
    await step(page, 1);
  }
  await expect(mission).toHaveAttribute("data-status", "done");
  expect(sawRunningThird).toBe(true);
  for (let i = 0; i < 4; i++) await expect(page.getByTestId(`mp-row-${i}`)).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("mp-stop")).toHaveCount(0);
  await expect(page.getByTestId("explorer-mission-uav-001")).toContainText("step 4/4");
  await expect(page.getByTestId("player-mission")).toContainText("uav-001 mission 4 / 4 · done");
  await expect.poll(async () => (await page.evaluate(() => window.__agentsim?.scene?.overlays()))?.mission.coarseDashes).toBe(0);
});

test("a step that cannot run is flagged in the editor with its reason and one-click fix, and run anyway the mission stops there, saying which step and why", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "discovery");
  const panel = await openRunConfig(page);
  await panel.getByTestId("ms-agent").selectOption("scout");
  await add(page, "explore");
  await add(page, "returnToBase");
  await expect(panel.getByTestId("ms-hint-0")).toContainText("explore needs airborne · take off first");
  await expect(panel.getByTestId("ms-fix-0")).toBeVisible();
  await runMission(page);

  const mission = page.getByTestId("inspector-mission");
  await step(page, 1);
  await expect(mission).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("mp-stop")).toContainText("Mission stopped at step 1 of 2 · explore refused: precondition_failed · step 2 not run");
  await expect(page.getByTestId("mp-row-0")).toHaveAttribute("data-state", "refused");
  await expect(page.getByTestId("mp-row-1")).toHaveAttribute("data-state", "skipped");
});
