import { expect, test } from "@playwright/test";
import { loadF2, openWorkspace, sceneSettled } from "./helpers.ts";
import { pixel, ratio } from "./pixels.ts";

// Switching the theme during a run keeps the scene's ground and walls: the scene is drawn again from the same map in the new theme, and what it draws is what a
// fresh load in that theme draws (the same pixels as the scene-contrast spec reads).

test("switching the theme during a run keeps the scene's ground and walls", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), "dark");
  await loadF2(page, "agents");
  await page.waitForTimeout(500);
  const before = await page.screenshot();
  const darkGround = await pixel(page, before, 450, 560);
  const darkBackground = await pixel(page, before, 600, 130);

  await openWorkspace(page, "settings");
  await page.getByTestId("theme-light").check();
  await openWorkspace(page, "scene");
  await sceneSettled(page);
  await page.waitForTimeout(1000);
  const after = await page.screenshot();
  const ground = await pixel(page, after, 450, 560);
  const background = await pixel(page, after, 600, 130);
  expect(ratio(ground, background), `light after the switch: ground ${ground} on background ${background}`).toBeGreaterThanOrEqual(1.2);
  // Not the dark ground in a light scene, and the ground is not the background.
  expect(ratio(ground, darkGround)).toBeGreaterThan(1.3);
  expect(ratio(background, darkBackground)).toBeGreaterThan(1.3);

  // Back to dark: the same scene as before.
  await openWorkspace(page, "settings");
  await page.getByTestId("theme-dark").check();
  await openWorkspace(page, "scene");
  await sceneSettled(page);
  await page.waitForTimeout(1000);
  const again = await page.screenshot();
  expect(ratio(await pixel(page, again, 450, 560), darkGround)).toBeLessThan(1.1);
});
