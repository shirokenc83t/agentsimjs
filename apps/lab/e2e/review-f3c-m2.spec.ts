import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// F3c M2 review material: every workspace in both themes, at 1440 x 900 and at 1000 px, of a 20-agent run with one agent selected (one subject, one hue) and the swarm knowledge band in the
// player. Skipped unless AGENTSIM_REVIEW_DIR names the folder the images go to.

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");
const THEMES = ["dark", "light"] as const;
const WIDTHS = [1440, 1000] as const;

async function shot(page: Page, name: string, theme: string, width: number): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  mkdirSync(DIR as string, { recursive: true });
  await page.screenshot({ path: `${DIR}/${name}-${width}-${theme}.png` });
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`every workspace, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
      await loadF2(page, "agents");
      await page.getByTestId("explorer-row-ugv-003").click();
      await runCommand(page, "Explore selected agent (ugv-003)");
      await step(page, 4);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 400", { timeout: 30_000 });
      await expect(page.getByTestId("player-knowledge-band")).toBeVisible({ timeout: 30_000 });
      await shot(page, "scene", theme, width);
      await openWorkspace(page, "debug");
      await expect(page.getByTestId("event-scroller")).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 30_000 }).toBeGreaterThan(0);
      await expect(page.getByTestId("timeline")).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, "debug", theme, width);
      await openWorkspace(page, "configurations");
      await expect(page.getByTestId("run-config-panel").getByTestId("rc-valid")).toBeVisible({ timeout: 30_000 });
      await shot(page, "configurations", theme, width);
      await openWorkspace(page, "data");
      await expect(page.getByTestId("sql-console")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await shot(page, "data", theme, width);
      await openWorkspace(page, "settings");
      await shot(page, "settings", theme, width);
      await runCommand(page, "Run headless");
      await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
      await shot(page, "experiments", theme, width);
      await page.getByTestId("hm-open-analysis").click();
      await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
      await shot(page, "analysis", theme, width);
    });
  }
}
