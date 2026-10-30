import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace } from "./helpers.ts";

// F4 M1 review material: the states of the System 2 minds as the designer drew them (LimitsPause), in both themes at 1440 x 900 and 1000 px: waiting for S2, the 80 % warning, the limit pause notice and
// the dialog that raises a limit. The states are put in the store by the probe's fixture (what the worker's `minds` messages would do): no provider is called. Skipped unless AGENTSIM_REVIEW_DIR names the
// folder the images go to.

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");
const THEMES = ["dark", "light"] as const;
const WIDTHS = [1440, 1000] as const;
type State = "quiet" | "waiting" | "waiting-several" | "warning" | "paused" | "raised";

async function shot(page: Page, name: string, theme: string, width: number): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]') ? document.activeElement.blur() : undefined));
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  mkdirSync(DIR as string, { recursive: true });
  await page.screenshot({ path: `${DIR}/${name}-${width}-${theme}.png` });
}

const fixture = (page: Page, state: State) => page.evaluate((s) => window.__agentsim?.mindsFixture?.(s), state);

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`the minds' states: waiting for S2, the 80 % warning, the pause and the raise dialog, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
      await loadF2(page, "discovery");
      await openWorkspace(page, "debug");
      // One step, so the player shows its transport (a run that waits at tick 0 shows the launch group instead).
      await page.getByTestId("step").click();
      await expect(page.getByTestId("status-tick")).toHaveText("tick 1");

      await fixture(page, "waiting");
      await expect(page.getByTestId("player-s2-wait")).toBeVisible();
      await expect(page.getByTestId("status-s2-wait")).toBeVisible();
      await page.waitForTimeout(2500); // the figure of the wait is wall time: the capture shows a few seconds
      await shot(page, "waiting", theme, width);

      await fixture(page, "waiting-several");
      await expect(page.getByTestId("player-s2-wait")).toContainText("(3)");
      await shot(page, "waiting-several", theme, width);

      await fixture(page, "warning");
      await expect(page.getByTestId("limit-warning-notice")).toBeVisible();
      await expect(page.getByTestId("status-s2-warning")).toHaveText("▲ tokens 82 % · uav-001");
      await expect(page.getByTestId("player-llm-tile")).toHaveAttribute("data-warn", "true");
      await shot(page, "warning", theme, width);

      await fixture(page, "paused");
      await expect(page.getByTestId("limit-notice")).toBeVisible();
      await expect(page.getByTestId("player-state")).toContainText("PAUSED · LIMIT");
      await expect(page.getByTestId("attention-limit")).toHaveText("▲ limit");
      await expect(page.getByTestId("play-limit-paused")).toBeDisabled();
      await shot(page, "pause", theme, width);

      await page.getByTestId("limit-raise").click();
      await expect(page.getByTestId("raise-dialog")).toBeVisible();
      await expect(page.getByTestId("raise-input")).toBeFocused();
      await shot(page, "raise-dialog", theme, width);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("raise-dialog")).toHaveCount(0);

      await fixture(page, "raised");
      await expect(page.getByTestId("limit-notice")).toHaveCount(0);
      await expect(page.getByTestId("player-llm-tile")).toContainText("/80k tok");
      await shot(page, "after-raise", theme, width);
    });
  }
}
