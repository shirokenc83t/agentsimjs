import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace, step } from "../helpers.ts";

/**
 * Visual regression of the missions (F3c M1), in both themes: the step editor (empty, a full mission, a validation error) and a mission running (the Inspector's Mission section, the
 * Explorer and Scene, the Log with the decision records), and a stopped one. A deterministic run of the F2 scene's UAV. Baselines only on the pinned image, as panels.spec.ts; with
 * AGENTSIM_REVIEW_DIR set the same screens are also written there unmasked, for the review of the designer.
 */
test.skip(process.env["AGENTSIM_VISUAL_IMAGE"] !== "1" && process.env["AGENTSIM_REVIEW_DIR"] === undefined, "visual baselines are checked only on the pinned Playwright image (ADR-0032 §9)");

const THEMES = ["dark", "light"] as const;
const REVIEW = process.env["AGENTSIM_REVIEW_DIR"];

async function settle(page: Page) {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** A baseline and, for the review, the same image unmasked. */
async function shot(page: Page, target: Locator, name: string, mask: Locator[] = [], hideCanvas = false) {
  if (REVIEW !== undefined) await target.screenshot({ path: `${REVIEW}/${name}.png`, animations: "disabled", caret: "hide" });
  if (hideCanvas) await page.addStyleTag({ content: "canvas { visibility: hidden !important; }" });
  if (process.env["AGENTSIM_VISUAL_IMAGE"] === "1") await expect(target).toHaveScreenshot(`${name}.png`, { mask });
}

async function openEditor(page: Page) {
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await panel.getByTestId("ms-agent").selectOption("scout");
  return panel;
}

async function compose(page: Page, panel: Locator) {
  for (const a of ["takeoff", "goTo", "explore", "returnToBase"]) await page.getByTestId("ms-add").selectOption(a);
  await panel.getByTestId("ms-arg-1-xM").fill("50");
  await panel.getByTestId("ms-arg-1-yM").fill("20");
  await panel.getByTestId("ms-arg-2-radiusM").fill("15");
}

for (const theme of THEMES) {
  test.describe(`missions, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
      await loadF2(page, "discovery");
      await page.addStyleTag({ content: ".dv-resize-container { display: none !important; }" });
    });

    test("the step editor: empty, a full mission, a validation error", async ({ page }) => {
      test.setTimeout(90_000);
      const panel = await openEditor(page);
      const section = panel.getByTestId("rc-mission");
      await expect(panel.getByTestId("ms-empty")).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, panel, `mission-editor-empty-${theme}`);
      await compose(page, panel);
      await expect(panel.getByTestId("ms-valid")).toContainText("✓ valid");
      await section.scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, panel, `mission-editor-full-${theme}`);
      // An error in words (a radius of 0) and a step that cannot run where it is (a go to before the take off).
      await panel.getByTestId("ms-arg-2-radiusM").fill("0");
      await panel.getByTestId("ms-up-1").click();
      await expect(panel.getByTestId("ms-error-2")).toBeVisible();
      await expect(panel.getByTestId("ms-hint-0")).toBeVisible();
      await settle(page);
      await shot(page, panel, `mission-editor-error-${theme}`);
    });

    test("a mission running: the Inspector, the Explorer and the Scene, and the Log with the decision records", async ({ page }) => {
      test.setTimeout(240_000);
      const panel = await openEditor(page);
      await compose(page, panel);
      await panel.getByTestId("rc-run").click();
      await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
      await openWorkspace(page, "scene");
      await page.getByTestId("explorer-row-uav-001").click();
      await step(page, 2);
      await expect(page.getByTestId("inspector-mission")).toHaveAttribute("data-status", "running");
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 30_000 });
      await settle(page);
      const mask = [page.locator(".telem"), page.getByTestId("status-recording-saved")];
      await shot(page, page.getByTestId("inspector"), `mission-inspector-running-${theme}`);
      await shot(page, page.getByTestId("explorer"), `mission-explorer-${theme}`);
      await settle(page);
      // The Scene with the tooltip of the UAV: its steps and their states. The baseline hides the canvas (WebGL is not compared) and keeps the labels and the tooltip.
      // The pointer goes to where the UAV is drawn now (the scene eases toward the sim state): a hover is retried until the tooltip shows.
      await expect
        .poll(
          async () => {
            const at = await page.evaluate(() => window.__agentsim?.scene?.screenOf("uav-001"));
            if (at !== undefined) {
              await page.mouse.move(at.x + 1, at.y + 1);
              await page.mouse.move(at.x, at.y);
            }
            return page.getByTestId("map-tooltip-mission").isVisible();
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      await shot(page, page.getByTestId("workspace-scene"), `mission-scene-${theme}`, mask, true);
      await openWorkspace(page, "debug");
      await page.getByTestId("log-filter").fill("kind:thought agent:uav-001 text:decision");
      await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 15_000 }).toBeGreaterThan(0);
      await page.getByTestId("event-scroller").evaluate((el) => {
        el.scrollTop = 0;
      });
      await settle(page);
      await shot(page, page.getByTestId("event-list"), `mission-log-${theme}`, [page.locator(".telem"), page.getByTestId("status-recording-saved"), page.getByTestId("event-detail")]);
    });

    test("a mission stopped at a refused step", async ({ page }) => {
      test.setTimeout(120_000);
      const panel = await openEditor(page);
      await page.getByTestId("ms-add").selectOption("explore");
      await page.getByTestId("ms-add").selectOption("returnToBase");
      await panel.getByTestId("rc-run").click();
      await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
      await openWorkspace(page, "scene");
      await page.getByTestId("explorer-row-uav-001").click();
      await step(page, 1);
      await expect(page.getByTestId("inspector-mission")).toHaveAttribute("data-status", "stopped");
      await settle(page);
      await shot(page, page.getByTestId("inspector"), `mission-inspector-stopped-${theme}`);
    });
  });
}
