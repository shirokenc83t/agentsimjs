import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace } from "./helpers.ts";

// F4 M2 review material: what the researcher sees of the new time mode, in both themes: the run configuration's Time mode field with `latency-modeled` chosen (the field in the Run section), and the player's
// time-mode chip, which now says what the loaded run declares. Skipped unless AGENTSIM_REVIEW_DIR names the folder the images go to.

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");

for (const theme of ["dark", "light"] as const) {
  test(`the time mode choice, ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
    await loadF2(page, "discovery");
    await openWorkspace(page, "configurations");
    await openPanelTab(page, "Run configuration");
    const field = page.getByTestId("rc-time-mode");
    await expect(field).toBeVisible();
    await expect(field.locator("option", { hasText: "latency-modeled" })).toHaveCount(1);
    await field.selectOption("latency-modeled");
    await expect(field).toHaveValue("latency-modeled");
    await page.mouse.move(2, 2);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    mkdirSync(DIR as string, { recursive: true });
    await page.getByTestId("rc-time-mode").locator("xpath=ancestor::section[1]").screenshot({ path: `${DIR}/time-mode-choice-${theme}.png` });
    await page.screenshot({ path: `${DIR}/configurations-latency-modeled-${theme}.png` });
  });
}
