import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { LABEL_PX } from "../src/panels/debug/timeline-geometry.ts";
import { loadDemo, loadF2, openWorkspace, runCommand, sendTo, step } from "./helpers.ts";

// F3b M4 review material: the screens the designer reviews, shot at 1440 x 900 in both themes. Not a test of anything: it is skipped unless AGENTSIM_REVIEW_DIR names
// the folder the images go to (`AGENTSIM_REVIEW_DIR=../agentsimjs-docs/docs/ui/review/f3b-m4 pnpm exec playwright test review-f3b-m4`).

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");
const AGENT = "ugv-001";
const THEMES = ["dark", "light"] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
async function shot(page: Page, name: string, theme: string): Promise<void> {
  await page.addStyleTag({ content: ".dv-resize-container { display: none !important; }" }); // the floating Performance window is the status bar's to open, not part of these screens
  await settle(page);
  mkdirSync(DIR as string, { recursive: true });
  await page.screenshot({ path: `${DIR}/${name}-${theme}.png` });
}

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
    });

    test("Experiments monitor: running, then done", async ({ page }) => {
      test.setTimeout(240_000);
      await loadDemo(page);
      await page.getByTestId("run-label").click();
      await page.getByTestId("headless-until").fill("5000");
      await page.getByTestId("run-headless-popover").click();
      await expect(page.getByTestId("hm-ticks")).toContainText("/ 50 000", { timeout: 30_000 });
      await expect(page.getByTestId("hm-speed")).toContainText("real time", { timeout: 15_000 });
      await page.waitForTimeout(2500); // a little progress and the sparklines have points
      await shot(page, "monitor-running", theme);
      await page.getByTestId("hm-stop").click();
      await expect(page.getByTestId("hm-state")).toContainText("stopped", { timeout: 30_000 });
      await runCommand(page, "Run headless");
      await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 90_000 });
      await expect(page.getByTestId("hm-volume")).toContainText(/stored \d/, { timeout: 15_000 });
      await shot(page, "monitor-done", theme);
    });

    test("Analysis: trajectories with the brush and markers, the series, the exports", async ({ page }) => {
      test.setTimeout(300_000);
      await loadF2(page, "discovery");
      await page.getByTestId(`explorer-row-${AGENT}`).click();
      await runCommand(page, `Explore selected agent (${AGENT})`);
      await step(page, 1);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 30_000 });
      await runCommand(page, "Run headless");
      await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
      await page.getByTestId("hm-open-analysis").click();
      await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
      await expect.poll(async () => Number(await page.getByTestId("map2d-canvas").getAttribute("data-markers")), { timeout: 15_000 }).toBeGreaterThan(0);
      await shot(page, "analysis-overview", theme);

      // A window brushed on the timeline: the filter's `t:` term, the markers of the window, the series cut to it.
      const tl = page.getByTestId("analysis-timeline-canvas");
      const box = await tl.boundingBox();
      if (!box) throw new Error("no timeline");
      const track = box.width - LABEL_PX;
      await page.mouse.move(box.x + LABEL_PX + track * 0.15, box.y + 8);
      await page.mouse.down();
      await page.mouse.move(box.x + LABEL_PX + track * 0.4, box.y + 8, { steps: 6 });
      await page.mouse.move(box.x + LABEL_PX + track * 0.7, box.y + 8, { steps: 6 });
      await page.mouse.up();
      await expect(page.getByTestId("an-clear-window")).toBeVisible();
      await page.mouse.move(2, 2);
      await shot(page, "analysis-brush", theme);

      // The series further down, and the export buttons with the JSONL one explained.
      await page.getByTestId("series-battery").scrollIntoViewIfNeeded();
      await shot(page, "analysis-series", theme);
      await page.getByTestId("an-export-jsonl").scrollIntoViewIfNeeded();
      await page.getByTestId("an-export-jsonl").hover();
      await page.waitForTimeout(700);
      await shot(page, "analysis-export", theme);
    });

    test("Scene 2D tab: live and replay", async ({ page }) => {
      test.setTimeout(240_000);
      await loadDemo(page);
      await sendTo(page, "ugv-001", 50, 10);
      await step(page, 3);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
      await page.getByTestId("map-view-2d").click();
      await expect.poll(async () => Number(await page.getByTestId("map2d-canvas").getAttribute("data-trajectories")), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
      await shot(page, "scene-2d-live", theme);
      await page.getByTestId("map-view-3d").click();
      await page.getByTestId("scrub-back").click();
      await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("map-view-2d").click();
      await expect.poll(async () => Number(await page.getByTestId("map2d-canvas").getAttribute("data-trajectories")), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
      await shot(page, "scene-2d-replay", theme);
    });

    test("Trace tree on a real run", async ({ page }) => {
      test.setTimeout(240_000);
      await loadF2(page, "discovery");
      await page.getByTestId(`explorer-row-${AGENT}`).click();
      await runCommand(page, `Explore selected agent (${AGENT})`);
      await step(page, 3);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 20_000 });
      await openWorkspace(page, "debug");
      await page.getByTestId("log-filter").fill(`kind:action agent:${AGENT}`);
      await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 15_000 }).toBeGreaterThan(0);
      await page.getByTestId("event-scroller").evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(async () => {
        await page.getByTestId("event-scroller").evaluate((el) => {
          el.scrollTop = 0;
        });
        await expect(page.locator('[data-testid^="event-row-"]').first()).toContainText("start", { timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await page.locator('[data-testid^="event-row-"]').first().click();
      await expect(page.getByTestId("trace-tree-selected")).toBeVisible();
      await expect(page.getByTestId("tt-children").locator('[data-testid^="trace-node-"]').first()).toBeVisible();
      await shot(page, "trace-tree-in-layout", theme);
      // The Trace window is small under the Log: maximized, the children and effects of the record are there too.
      await page.getByTestId("trace-tree").locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').locator('[data-testid^="wb-maximize-"]').click();
      await expect(page.getByTestId("tt-children").locator('[data-testid^="trace-node-"]').first()).toBeVisible();
      await shot(page, "trace-tree", theme);
    });
  });
}
