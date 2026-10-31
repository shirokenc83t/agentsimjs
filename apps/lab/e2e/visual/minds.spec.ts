import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadF2, openWorkspace } from "../helpers.ts";

/**
 * Visual regression of the System 2 minds' limit UI (F4 M1), in both themes: the notice of a pause, the dialog that raises a limit, the 80 % notice, and the player with the minds' tiles and the wait.
 * The states come from the probe's fixture (what the worker's `minds` messages would put in the store): no provider is called. Baselines only on the pinned image, as panels.spec.ts; with
 * AGENTSIM_REVIEW_DIR set the same screens are also written there.
 */
test.skip(process.env["AGENTSIM_VISUAL_IMAGE"] !== "1" && process.env["AGENTSIM_REVIEW_DIR"] === undefined, "visual baselines are checked only on the pinned Playwright image (ADR-0032 §9)");

const THEMES = ["dark", "light"] as const;
const REVIEW = process.env["AGENTSIM_REVIEW_DIR"];

async function settle(page: Page) {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]') ? document.activeElement.blur() : undefined));
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function shot(page: Page, target: Locator, name: string, mask: Locator[] = []) {
  await settle(page);
  if (REVIEW !== undefined) await target.screenshot({ path: `${REVIEW}/${name}.png`, animations: "disabled", caret: "hide" });
  if (process.env["AGENTSIM_VISUAL_IMAGE"] === "1") await expect(target).toHaveScreenshot(`${name}.png`, { mask });
}

for (const theme of THEMES) {
  test(`the limit notice, the raise dialog, the warning and the player's tiles, ${theme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
    await loadF2(page, "discovery");
    await openWorkspace(page, "debug");
    await page.getByTestId("step").click();
    await expect(page.getByTestId("status-tick")).toHaveText("tick 1");

    await page.evaluate(() => window.__agentsim?.mindsFixture?.("warning"));
    await expect(page.getByTestId("limit-warning-notice")).toBeVisible();
    await shot(page, page.getByTestId("limit-warning-notice"), `minds-warning-notice-${theme}`);

    await page.evaluate(() => window.__agentsim?.mindsFixture?.("paused"));
    await expect(page.getByTestId("limit-notice")).toBeVisible();
    await shot(page, page.getByTestId("limit-notice"), `minds-pause-notice-${theme}`);
    await page.getByTestId("limit-raise").click();
    await expect(page.getByTestId("raise-dialog")).toBeVisible();
    await shot(page, page.getByTestId("raise-dialog"), `minds-raise-dialog-${theme}`);
    await page.keyboard.press("Escape");

    // The player's tiles at the limit (the wait's wall-clock figure is masked by taking the tiles only).
    // The meter of the tick cost under its figure is the machine's (its bar moves with the load): masked.
    await shot(page, page.locator(".telem"), `minds-player-tiles-${theme}`, [page.locator(".telem .tile", { hasText: "Tick cost" })]);
  });
}
