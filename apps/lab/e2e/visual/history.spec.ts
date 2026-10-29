import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace, step } from "../helpers.ts";

/**
 * Visual regression of the agent history and the audit (F3c M3), in both themes, of the deterministic mission run of the F2 scene's UAV: the history with the mission's chain opened
 * on three levels, and the history and audit tab of Analysis. Baselines only on the pinned image, as panels.spec.ts; with AGENTSIM_REVIEW_DIR set the same screens are also written
 * there.
 */
test.skip(process.env["AGENTSIM_VISUAL_IMAGE"] !== "1" && process.env["AGENTSIM_REVIEW_DIR"] === undefined, "visual baselines are checked only on the pinned Playwright image (ADR-0032 §9)");

const THEMES = ["dark", "light"] as const;
const REVIEW = process.env["AGENTSIM_REVIEW_DIR"];

async function settle(page: Page) {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function shot(page: Page, target: Locator, name: string) {
  await settle(page);
  if (REVIEW !== undefined) await target.screenshot({ path: `${REVIEW}/${name}.png`, animations: "disabled", caret: "hide" });
  if (process.env["AGENTSIM_VISUAL_IMAGE"] === "1") await expect(target).toHaveScreenshot(`${name}.png`);
}

for (const theme of THEMES) {
  test.describe(`history and audit, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
      await loadF2(page, "discovery");
      await openWorkspace(page, "configurations");
      await openPanelTab(page, "Run configuration");
      const panel = page.getByTestId("run-config-panel");
      await expect(panel.getByTestId("rc-valid")).toBeVisible();
      await panel.getByTestId("ms-agent").selectOption("scout");
      for (const a of ["takeoff", "goTo", "explore", "returnToBase"]) await page.getByTestId("ms-add").selectOption(a);
      await panel.getByTestId("ms-arg-1-xM").fill("50");
      await panel.getByTestId("ms-arg-1-yM").fill("20");
      await panel.getByTestId("ms-arg-2-radiusM").fill("15");
      await panel.getByTestId("rc-run").click();
      await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
      await openWorkspace(page, "scene");
      await page.getByTestId("explorer-row-uav-001").click();
      await step(page, 2);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 30_000 });
    });

    test("the history of the mission's UAV with its chain opened on three levels", async ({ page }) => {
      test.setTimeout(240_000);
      await openWorkspace(page, "debug");
      await expect(page.getByTestId("event-scroller")).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("h");
      const history = page.getByTestId("agent-history");
      await expect(history).toHaveAttribute("data-agent", "uav-001");
      const decision = page.getByTestId("ah-row-1").locator('[data-kind="decision"]').first();
      await expect(decision).toBeVisible({ timeout: 30_000 });
      await decision.dblclick();
      const started = page.getByTestId("ah-row-3").locator('[data-kind="record"]').first();
      await expect(started).toBeVisible({ timeout: 15_000 });
      await started.dblclick();
      await expect(page.getByTestId("ah-row-4")).toBeVisible();
      await expect.poll(async () => await page.getByTestId("ah-row-4").locator("[data-node]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
      await shot(page, history, `history-mission-${theme}`);
    });

    test("the history and audit tab in Analysis", async ({ page }) => {
      test.setTimeout(240_000);
      await openWorkspace(page, "analysis");
      await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
      await page.keyboard.press("h");
      const audit = page.getByTestId("agent-audit");
      await expect(audit).toBeVisible();
      await expect(page.getByTestId("aa-findings")).toContainText("ran", { timeout: 30_000 });
      await expect.poll(async () => await page.getByTestId("aa-table").locator('tr[data-kind="action"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await shot(page, audit, `audit-mission-${theme}`);
    });
  });
}
