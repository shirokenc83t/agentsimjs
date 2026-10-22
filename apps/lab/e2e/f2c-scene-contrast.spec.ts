import { expect, test } from "@playwright/test";
import { loadF2 } from "./helpers.ts";
import { pixel, ratio } from "./pixels.ts";

// The scene tells its ground from its background in both themes (ADR-0032: scene colours come from tokens). Found by a manual check of the F2 20 agents preset in the
// dark theme: the ground was 1.1:1 against the background, a floor nobody sees. The rendered pixels are read from a screenshot of the Scene.

for (const theme of ["dark", "light"] as const) {
  test(`the F2 20 agents scene: the ground is distinguishable from the background, ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
    await loadF2(page, "agents");
    await page.waitForTimeout(1000);
    const png = await page.screenshot();
    // At the default 1280 × 720 viewport and the default camera: the backdrop above the horizon, between the two overlay panels; the ground below it, left of the wall.
    const background = await pixel(page, png, 600, 130);
    const ground = await pixel(page, png, 450, 560);
    expect(ratio(ground, background), `${theme}: ground ${ground} on background ${background}`).toBeGreaterThanOrEqual(1.2);
  });
}
