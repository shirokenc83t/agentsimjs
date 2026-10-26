import { expect, test } from "@playwright/test";
import { loadDemo, sendTo, step } from "./helpers.ts";

// The Scene's 2D tab (UI-SPEC section 3, ADR-0029): the Scene's map from above, with the same component as the Analysis workspace, for the live run and for a replay.

test("MAP 2D | 3D: the live run seen from above, the agents where they are with the paths they took; a click on one selects it; and the same for a replay", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await sendTo(page, "ugv-001", 50, 10);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });

  await expect(page.getByTestId("map-view-3d")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scene-2d")).toHaveCount(0);
  await page.getByTestId("map-view-2d").click();
  await expect(page.getByTestId("scene-2d")).toBeVisible();
  const canvas = page.getByTestId("map2d-canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-trajectories")), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  // The 3D-only controls are not there in 2D; the switch is.
  await expect(page.getByTestId("overlay-rays")).toHaveCount(0);
  await expect(page.getByTestId("send-to")).toHaveCount(0);

  // A click on an agent selects it, as in the 3D view (the Explorer follows): the agents are on the map as a list of buttons too, for the keyboard.
  await page.getByTestId("explorer-row-uav-001").click(); // another agent is selected first
  await expect(page.getByTestId("explorer-row-uav-001")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("map2d-agent-ugv-002").dispatchEvent("click");
  await expect(page.getByTestId("explorer-row-ugv-002").first()).toHaveAttribute("aria-selected", "true");
  // Back to 3D, and again in a replay of the run (its source is the recording).
  await page.getByTestId("map-view-3d").click();
  await expect(page.getByTestId("scene-2d")).toHaveCount(0);
  await page.getByTestId("scrub-back").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("map-view-2d").click();
  await expect.poll(async () => Number(await page.getByTestId("map2d-canvas").getAttribute("data-trajectories")), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
});
