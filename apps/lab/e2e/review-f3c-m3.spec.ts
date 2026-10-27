import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace, runCommand, step } from "./helpers.ts";

// F3c M3 review material, both themes at 1440 x 900 and 1000 px: the band with the union, the agent history folded, exploded three levels, with the overview and its brush on a big run,
// a mission's chain, the audit and the provenance. Skipped unless AGENTSIM_REVIEW_DIR names the folder the images go to.

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

async function setup(page: Page, theme: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme as "dark" | "light", reducedMotion: "reduce" });
  await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`a big run: the union band, the history folded, exploded three levels, with the overview, the audit and the provenance, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(420_000);
      await setup(page, theme, width);
      await loadF2(page, "agents");
      await page.getByTestId("explorer-row-ugv-003").click();
      await runCommand(page, "Explore selected agent (ugv-003)");
      await step(page, 6);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 30_000 });
      await expect(page.getByTestId("player-knowledge-band")).toHaveAttribute("data-kind", "union", { timeout: 120_000 });
      await shot(page, "band-union", theme, width);

      // The history of the selected agent, in the Debug window: folded, then exploded three levels (the action, its steps, a step's records), then with the brush on the overview.
      await openWorkspace(page, "debug");
      await expect(page.getByTestId("event-scroller")).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("h");
      await expect(page.getByTestId("agent-history")).toHaveAttribute("data-agent", "ugv-003");
      const explore = page.getByTestId("ah-row-2").locator('[data-kind="action"]', { hasText: "explore" }).first();
      await expect(explore).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(400);
      await shot(page, "history-folded", theme, width);
      await explore.click();
      await explore.dblclick();
      await expect.poll(async () => await page.getByTestId("ah-row-3").locator("[data-node]").count(), { timeout: 20_000 }).toBeGreaterThan(1);
      // The third level: an iteration that has records of its own (the first that does).
      const iterations = page.getByTestId("ah-row-3").locator('[data-kind="record"]', { hasText: "iteration" });
      const n = await iterations.count();
      // The widest first: a 0.1 s iteration has little to show.
      const widths = await Promise.all(Array.from({ length: n }, async (_, i) => ({ i, w: (await iterations.nth(i).boundingBox())?.width ?? 0 })));
      const order = widths.sort((a, b) => b.w - a.w).map((x) => x.i);
      for (const i of order.slice(0, 6)) {
        await iterations.nth(i).dblclick();
        await page.waitForTimeout(700);
        if ((await page.getByTestId("ah-row-4").locator("[data-node]").count()) > 0) break;
        await page.getByTestId("agent-history").focus();
        await page.keyboard.press("Backspace");
      }
      await expect(page.getByTestId("ah-row-4")).toBeVisible();
      await page.waitForTimeout(400);
      await shot(page, "history-exploded", theme, width);
      const strip = page.getByTestId("ah-overview");
      const box = await strip.boundingBox();
      if (box !== null) {
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
        await page.mouse.up();
      }
      await expect(page.getByTestId("ah-brush")).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, "history-big-overview", theme, width);

      // Analysis: the tab of the agent, its audit, and the provenance of a point.
      await runCommand(page, "Run headless");
      await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 120_000 });
      await page.getByTestId("hm-open-analysis").click();
      await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
      await page.getByTestId("an-agent-ugv-003").click({ modifiers: ["Shift"] });
      await page.keyboard.press("h");
      await expect(page.getByTestId("agent-audit")).toBeVisible();
      await expect(page.getByTestId("aa-findings")).toContainText("ran", { timeout: 30_000 });
      const rows = page.getByTestId("aa-table").locator('tr[data-kind="action"]');
      await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await rows.first().click();
      await page.waitForTimeout(400);
      await shot(page, "audit", theme, width);
      const chart = page.getByTestId("agent-audit").getByTestId("series-planner-expansions").locator("svg");
      await expect(chart).toBeVisible({ timeout: 20_000 });
      const spot = await chart.evaluate((svg) => {
        const pts = (svg.querySelector("polyline.line")?.getAttribute("points") ?? "").split(" ");
        const [x, y] = (pts[Math.floor(pts.length / 2)] ?? "").split(",").map(Number);
        const r = svg.getBoundingClientRect();
        return { x: r.left + (x ?? 0), y: r.top + (y ?? 0) };
      });
      await page.mouse.click(spot.x, spot.y);
      await expect(page.getByTestId("aa-prov-lead")).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, "provenance", theme, width);
    });

    test(`a mission: its decisions and the chain on three levels, ${theme}, ${width} px`, async ({ page }) => {
      test.setTimeout(300_000);
      await setup(page, theme, width);
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
      await page.getByTestId("rc-run").click();
      await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
      await openWorkspace(page, "scene");
      await page.getByTestId("explorer-row-uav-001").click();
      const mission = page.getByTestId("inspector-mission");
      for (let k = 0; k < 120 && (await mission.getAttribute("data-status")) !== "done"; k++) await step(page, 1);
      await expect(page.getByTestId("status-recording-saved")).toContainText("saved to tick", { timeout: 30_000 });
      await openWorkspace(page, "debug");
      await expect(page.getByTestId("event-scroller")).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("h");
      await expect(page.getByTestId("agent-history")).toHaveAttribute("data-agent", "uav-001");
      const decision = page.getByTestId("ah-row-1").locator('[data-kind="decision"]').first();
      await expect(decision).toBeVisible({ timeout: 30_000 });
      await decision.dblclick();
      const started = page.getByTestId("ah-row-3").locator('[data-kind="record"]').first();
      await expect(started).toBeVisible({ timeout: 15_000 });
      await started.dblclick();
      await expect(page.getByTestId("ah-row-4")).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, "history-mission", theme, width);
    });
  }
}
