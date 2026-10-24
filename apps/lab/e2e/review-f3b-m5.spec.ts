import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, openWorkspace, runCommand, sendTo, step, stepUntilEnded } from "./helpers.ts";

// F3b M5 review material: the screens of the maintainer's manual check and of the designer's proposals, shot at 1440 x 900 in both themes. Skipped unless AGENTSIM_REVIEW_DIR names
// the folder the images go to (`AGENTSIM_REVIEW_DIR=../agentsimjs-docs/docs/ui/review/f3b-m5 pnpm exec playwright test review-f3b-m5`).

const DIR = process.env["AGENTSIM_REVIEW_DIR"];
test.skip(!DIR, "review screenshots are made only when AGENTSIM_REVIEW_DIR is set");
const AGENT = "ugv-001";
const THEMES = ["dark", "light"] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
async function shot(page: Page, name: string, theme: string, hideFloats = true): Promise<void> {
  // The collapsed floating windows of the Scene are the status bar's and the palette's to open: not part of most of these screens (the trace graph is one).
  if (hideFloats) await page.addStyleTag({ content: ".dv-resize-container.collapsed, .dv-resize-container:has(.collapsed) { display: none !important; }" });
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

    test("READY at the start, the Re-run menu, the theme menu", async ({ page }) => {
      test.setTimeout(120_000);
      await loadDemo(page);
      await expect(page.getByTestId("ready-start")).toBeVisible();
      await shot(page, "ready-start", theme);
      await page.getByTestId("rerun-menu").click();
      await expect(page.getByTestId("rerun-pop")).toBeVisible();
      await shot(page, "rerun-menu", theme);
      await page.keyboard.press("Escape");
      await page.getByTestId("theme-button").click();
      await expect(page.getByTestId("theme-menu")).toBeVisible();
      await shot(page, "theme-menu", theme);
    });

    test("action states and the precondition hint", async ({ page }) => {
      test.setTimeout(180_000);
      await loadDemo(page);
      await page.getByTestId("explorer-row-uav-001").click();
      await expect(page.getByTestId("command-hint")).toContainText("Explore needs airborne");
      await shot(page, "precondition-hint", theme);
      await page.getByTestId("command-takeoff").click();
      for (let i = 0; i < 8; i++) await page.getByTestId("step").click(); // a few ticks: the climb has started
      await expect(page.getByTestId("command-takeoff")).toHaveAttribute("data-state", "running");
      await shot(page, "action-takeoff-running", theme);
      await stepUntilEnded(page, 6);
      await expect(page.getByTestId("command-takeoff")).toHaveAttribute("data-state", "done");
      await shot(page, "action-takeoff-done", theme);
    });

    test("explore running with its hold button, and send-to armed", async ({ page }) => {
      test.setTimeout(180_000);
      await loadF2(page, "discovery");
      await page.getByTestId(`explorer-row-${AGENT}`).click();
      await page.getByTestId("command-explore").click();
      await page.getByTestId("step").click(); // a tick: the action has started and is running
      await page.getByTestId("step").click();
      await expect(page.getByTestId("command-explore")).toHaveAttribute("data-state", "running");
      await expect(page.getByTestId("command-hold-explore")).toBeVisible();
      await page.getByTestId("send-to").click();
      await expect(page.getByTestId("send-to")).toHaveAttribute("aria-pressed", "true");
      await shot(page, "action-explore-running-armed", theme);
    });

    test("the trace graph with a group of children, and grouped by kind", async ({ page }) => {
      test.setTimeout(240_000);
      await loadF2(page, "discovery");
      await page.getByTestId(`explorer-row-${AGENT}`).click();
      await runCommand(page, `Explore selected agent (${AGENT})`);
      await step(page, 8);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 800", { timeout: 30_000 });
      await openWorkspace(page, "debug");
      await page.getByTestId("log-filter").fill(`kind:action agent:${AGENT} text:start`);
      await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 15_000 }).toBeGreaterThan(0);
      await page.getByTestId("event-scroller").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.locator('[data-testid^="event-row-"]').filter({ hasText: "start" }).first().click();
      await expect(page.getByTestId("trace-tree-selected")).toBeVisible();
      await page.getByTestId("trace-open-graph").click();
      await expect(page.getByTestId("tg-group-node")).toBeVisible({ timeout: 15_000 });
      await shot(page, "trace-graph", theme, false);
      await page.getByTestId("tg-group").check();
      await page.getByTestId("tg-depth-2").click();
      await shot(page, "trace-graph-grouped", theme, false);
    });

    test("the two Debug layouts", async ({ page }) => {
      test.setTimeout(180_000);
      await loadF2(page, "discovery");
      await page.getByTestId(`explorer-row-${AGENT}`).click();
      await runCommand(page, `Explore selected agent (${AGENT})`);
      await step(page, 3);
      await openWorkspace(page, "debug");
      await page.getByTestId("log-filter").fill("kind:action");
      await page.waitForTimeout(600);
      await shot(page, "debug-default", theme);
      await page.keyboard.press("Alt+L");
      await expect(page.getByTestId("layout-select")).toHaveValue("debug · two columns");
      await page.waitForTimeout(600);
      await shot(page, "debug-two-columns", theme);
    });

    test("the SQL console with its results maximized, and Configurations as a column", async ({ page }) => {
      test.setTimeout(180_000);
      await loadDemo(page);
      await step(page, 2);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 30_000 });
      await openWorkspace(page, "data");
      await page.getByTestId("sql-editor").fill("SELECT kind, count(*) AS n FROM trace_records GROUP BY kind ORDER BY n DESC");
      await page.getByTestId("sql-run").click();
      await expect(page.getByTestId("sql-status").first()).toContainText("rows", { timeout: 15_000 });
      await shot(page, "sql-split", theme);
      await page.getByTestId("sql-maximize").click();
      await shot(page, "sql-maximized", theme);
      await openWorkspace(page, "configurations");
      await page.getByRole("tab", { name: /Run configuration/ }).click();
      await expect(page.getByTestId("run-config-panel")).toBeVisible();
      await page.getByTestId("rc-jump-planning").click();
      await shot(page, "configurations-column", theme);
    });

    test("the Analysis map after a theme switch while it is open", async ({ page }) => {
      test.setTimeout(240_000);
      // Opened in this theme, switched to the other with the button and back with it: the canvases are drawn with the tokens of the theme they end in.
      const other = theme === "dark" ? "light" : "dark";
      await loadDemo(page);
      await sendTo(page, "ugv-001", 50, 10);
      await step(page, 3);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
      await runCommand(page, "Re-run headless");
      await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
      await page.getByTestId("hm-open-analysis").click();
      await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
      await page.getByTestId("theme-button").click();
      await page.getByTestId(`theme-${other}`).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", other);
      await page.waitForTimeout(300);
      await page.getByTestId("theme-button").click();
      await page.getByTestId(`theme-${theme}`).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.waitForTimeout(500);
      await shot(page, "analysis-after-switch", theme);
    });
  });
}
