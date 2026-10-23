import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, openPanelTab, openWorkspace, sceneSettled, sendTo, step } from "../helpers.ts";

/**
 * Visual regression (ADR-0032 §9): a fixed set of panels in both themes, from the deterministic F1 demo at
 * tick 0. Baselines are generated and checked only on the pinned Playwright image (text rendering differs
 * between operating systems): the jobs set AGENTSIM_VISUAL_IMAGE=1. Elsewhere these tests skip.
 */
test.skip(process.env["AGENTSIM_VISUAL_IMAGE"] !== "1", "visual baselines are checked only on the pinned Playwright image (ADR-0032 §9)");

const THEMES = ["dark", "light"] as const;

/** Fonts loaded, no pending layout, no focused control (one whose focus came back by keyboard shows its focus ring); animations and caret are disabled by the screenshot options. */
async function settle(page: Page) {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      // The boot mirror of the theme setting (ADR-0032 §2): the first paint is already in this theme.
      await page.addInitScript((t) => window.localStorage.setItem("agentsim.ui.theme", t), theme);
      await loadDemo(page);
      // The floating Performance window sits over the panels' corners; these images are of the panels themselves.
      await page.addStyleTag({ content: ".dv-resize-container { display: none !important; }" });
    });

    test("shell: toolbar and status line", async ({ page }) => {
      await settle(page);
      // The top bar and the player; the telemetry tiles are measured values of the worker and change from run to run.
      await expect(page.getByTestId("shell-header")).toHaveScreenshot(`shell-toolbar-${theme}.png`, { mask: [page.locator(".telem")] });
      // Storage sizes depend on the database file and the browser's quota; how far the run is saved depends on when the writer flushed.
      await expect(page.getByTestId("statusline")).toHaveScreenshot(`shell-statusline-${theme}.png`, { mask: [page.getByTestId("status-storage-size"), page.getByTestId("status-recording-saved"), page.getByTestId("status-frame")] });
    });

    test("Explorer and Inspector (agent)", async ({ page }) => {
      await page.getByTestId("explorer-row-ugv-001").click();
      await expect(page.getByTestId("inspector-agent")).toBeVisible();
      // The streamed sections (what the mind receives, the researcher view) have their first data.
      await expect(page.getByTestId("mind-request-status")).toBeVisible();
      await expect(page.getByTestId("researcher-ideal")).toBeVisible();
      await settle(page);
      await expect(page.getByTestId("explorer")).toHaveScreenshot(`explorer-${theme}.png`);
      await expect(page.getByTestId("inspector")).toHaveScreenshot(`inspector-agent-${theme}.png`);
    });

    // F2: the sections of an agent with an unknown map at tick 0 (the F2 discovery demo): what the mind receives, the
    // researcher-only view, the researcher commands. All values are those of tick 0 (deterministic).
    test("Inspector (F2: mind view, researcher view, commands)", async ({ page }) => {
      test.setTimeout(90_000);
      await loadF2(page, "discovery");
      await page.addStyleTag({ content: ".dv-resize-container { display: none !important; }" });
      await page.getByTestId("explorer-row-ugv-001").click();
      await expect(page.getByTestId("mind-request-status")).toContainText("would be sent now");
      await expect(page.getByTestId("researcher-unknown")).toBeVisible();
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(page.getByTestId("inspector-mind-view")).toHaveScreenshot(`inspector-beliefs-${theme}.png`);
      await expect(page.getByTestId("inspector-researcher")).toHaveScreenshot(`inspector-researcher-${theme}.png`);
      await expect(page.getByTestId("inspector-commands")).toHaveScreenshot(`inspector-commands-${theme}.png`);
    });

    test("Inspector (cell)", async ({ page }) => {
      const wall = await page.evaluate(() => window.__agentsim?.scene?.screenOfGround(30.4, 20.2));
      await page.mouse.click(wall?.x ?? 0, wall?.y ?? 0);
      await expect(page.getByTestId("inspector-cell")).toBeVisible();
      await settle(page);
      await expect(page.getByTestId("inspector")).toHaveScreenshot(`inspector-cell-${theme}.png`);
    });

    test("run configuration and cost-profile form", async ({ page }) => {
      await openWorkspace(page, "author");
      await openPanelTab(page, "Run configuration");
      const panel = page.getByTestId("run-config-panel");
      await expect(panel.getByTestId("rc-valid")).toBeVisible();
      await settle(page);
      await expect(panel).toHaveScreenshot(`run-config-${theme}.png`);
      await expect(panel.getByTestId("rc-beliefs")).toHaveScreenshot(`run-config-beliefs-${theme}.png`);
      // The form with a set weight, a valid and an invalid constraint (inline code shown).
      await panel.getByTestId("rc-planning-scope").selectOption("byAgent.rover");
      await panel.getByTestId("rc-override-profile").check();
      await panel.getByTestId("rc-profile-weight-terrain").fill("1");
      await panel.getByTestId("rc-profile-add-constraint").click();
      await panel.getByTestId("rc-profile-constraint-0").fill("slope < 0.3");
      await panel.getByTestId("rc-profile-add-constraint").click();
      await panel.getByTestId("rc-profile-constraint-1").fill("speed > 2");
      await expect(panel.getByTestId("rc-profile-constraint-1-issue")).toBeVisible();
      await page.locator("body").click({ position: { x: 1, y: 1 } }); // blur: no focus ring in the shot
      await settle(page);
      await expect(panel.getByTestId("rc-profile")).toHaveScreenshot(`cost-profile-${theme}.png`);
    });

    // F2b: the planner choice of a planning entry: a shipped preset with its description and document, an inline strategy with
    // the resolver's code and path next to the editor, and the lazy-on-belief-map warning.
    test("run configuration: strategy picker, inline error and warning (F2b)", async ({ page }) => {
      await openWorkspace(page, "author");
      await openPanelTab(page, "Run configuration");
      const panel = page.getByTestId("run-config-panel");
      await panel.getByTestId("rc-planner").selectOption("strategy");
      await panel.getByTestId("rc-strategy-preset").selectOption("short-astar-long-hpa@1");
      await expect(panel.getByTestId("rc-strategy-view")).toBeVisible();
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(panel.getByTestId("rc-planning")).toHaveScreenshot(`run-config-strategy-preset-${theme}.png`);
      await panel.getByTestId("rc-strategy-preset").selectOption("inline");
      const doc = (root: unknown) => JSON.stringify({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root }, null, 2);
      const astar = { kind: "algorithm", algorithm: "astar" };
      const hpa = { kind: "algorithm", algorithm: "hpa" };
      await panel.getByTestId("rc-strategy-json").fill(doc({ kind: "select", branches: [{ when: "nonsense > 1", then: astar }], else: hpa }));
      await expect(panel.getByTestId("rc-strategy-error")).toContainText("expr_unknown_name");
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(panel.getByTestId("rc-strategy")).toHaveScreenshot(`run-config-strategy-error-${theme}.png`);
      await panel.getByTestId("rc-beliefs-init").selectOption("unknown");
      await panel.getByTestId("rc-strategy-json").fill(doc({ kind: "refine", mode: "lazy", coarse: hpa, local: astar }));
      await expect(panel.getByTestId("rc-warning-ugv-001")).toBeVisible();
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(panel.getByTestId("rc-planning")).toHaveScreenshot(`run-config-strategy-warning-${theme}.png`);
    });

    // F2b: the Inspector's planning queries (one query selected: branch with condition values, each search) and the Strategy
    // test (researcher tool) with a result on the agent's belief map. Everything is a count of sim ticks, so deterministic.
    test("Inspector: planning queries and Strategy test (F2b)", async ({ page }) => {
      test.setTimeout(120_000);
      await openWorkspace(page, "author");
      await openPanelTab(page, "Run configuration");
      const panel = page.getByTestId("run-config-panel");
      await panel.getByTestId("rc-beliefs-init").selectOption("unknown");
      await panel.getByTestId("rc-planner").selectOption("strategy");
      await panel.getByTestId("rc-strategy-preset").selectOption("short-astar-long-hpa@1");
      await panel.getByTestId("rc-run").click();
      await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
      await openWorkspace(page, "scene");
      await sceneSettled(page);
      await sendTo(page, "ugv-001", 50, 10);
      await step(page, 1);
      await page.getByTestId(/^plan-query-row-/).first().click();
      await page.getByTestId("st-strategy").selectOption("astar-then-hpa@1");
      await page.getByTestId("st-x").fill("50");
      await page.getByTestId("st-y").fill("40");
      await page.getByTestId("st-run").click();
      await expect(page.getByTestId("st-status")).toBeVisible();
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(page.getByTestId("inspector-queries")).toHaveScreenshot(`inspector-queries-${theme}.png`);
      await expect(page.getByTestId("inspector-strategy-test")).toHaveScreenshot(`inspector-strategy-test-${theme}.png`);
    });

    test("scenario editor (sidebar: document, brush, agent and body form, zones)", async ({ page }) => {
      test.setTimeout(90_000);
      await openWorkspace(page, "author");
      await page.getByTestId("ed-new").click();
      await page.getByTestId("ed-new-id").fill("visual-yard");
      await page.getByTestId("ed-new-x").fill("64");
      await page.getByTestId("ed-new-y").fill("64");
      await page.getByTestId("ed-new-create").click();
      await sceneSettled(page);
      // A placed agent (the only step that needs the 3D view).
      await page.getByTestId("ed-tool-agent").click();
      const p = await page.evaluate(() => window.__agentsim?.scene?.screenOfGround(10, 10));
      await page.mouse.click(p?.x ?? 0, p?.y ?? 0);
      await expect(page.getByTestId("ed-agent-form")).toBeVisible();
      // The paint tool shows the brush section; the selected agent's form stays visible.
      await page.getByTestId("ed-tool-paint").click();
      // The shots cover the sidebar only. Hide the 3D view (the renderer shrinks its canvas to 1 × 1), then make
      // the page tall enough that the sidebar never scrolls: a huge WebGL canvas on software GL starves the page,
      // and a scrolled shot would depend on focus.
      await page.addStyleTag({ content: ".scenario-editor .editor-view { display: none !important; }" });
      await page.setViewportSize({ width: 1440, height: 2600 });
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(page.getByTestId("ed-side")).toHaveScreenshot(`editor-paint-${theme}.png`);
      // An authored body value and a body warning.
      await page.getByTestId("ed-body-drive").selectOption("forward-only");
      await page.getByTestId("ed-body-lookaheadM").fill("3");
      await expect(page.getByTestId("ed-body-warnings")).toBeVisible();
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(page.getByTestId("ed-side")).toHaveScreenshot(`editor-agent-${theme}.png`);
    });

    // F2: prior maps in the scenario editor: made from the world, edited with the prior brush (the banner says which layer is painted).
    test("scenario editor (prior maps and the edit target)", async ({ page }) => {
      test.setTimeout(90_000);
      await openWorkspace(page, "author");
      await page.getByTestId("ed-open-select").selectOption("f1-demo");
      await page.getByTestId("ed-open").click();
      await sceneSettled(page);
      await page.getByTestId("ed-prior-new-id").fill("survey");
      await page.getByTestId("ed-prior-create").click();
      await page.getByTestId("ed-prior-edit-survey").click();
      await expect(page.getByTestId("ed-edit-target")).toContainText("PRIOR");
      await page.addStyleTag({ content: ".scenario-editor .editor-view { display: none !important; }" });
      await page.setViewportSize({ width: 1440, height: 2600 });
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      await expect(page.getByTestId("ed-side")).toHaveScreenshot(`editor-priors-${theme}.png`);
    });

    test("replay: the player badge and the top bar's replay segment", async ({ page }) => {
      test.setTimeout(120_000);
      await page.getByTestId("run-label").click();
      const id = (await page.getByTestId("run-id").textContent()) ?? "";
      await page.keyboard.press("Escape");
      await step(page, 1);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 15_000 });
      await openWorkspace(page, "data");
      await page.getByRole("button", { name: "Refresh" }).click();
      await page.getByTestId(`replay-${id}`).click();
      await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 15_000 });
      await openWorkspace(page, "scene");
      await expect(page.getByTestId("replay-bar")).toBeVisible();
      await settle(page);
      await expect(page.getByTestId("player")).toHaveScreenshot(`replay-player-${theme}.png`, { mask: [page.getByTestId("replay-pose-rate")] });
      await expect(page.getByTestId("shell-header")).toHaveScreenshot(`replay-toolbar-${theme}.png`, { mask: [page.locator(".telem")] });
    });

    // F3b M3: the Data workspace (the storage panel with the SQL console under it), the command palette and the run popover. What depends on the database file, the browser's
    // quota or the wall clock is masked.
    test("Data: storage and the SQL console", async ({ page }) => {
      test.setTimeout(90_000);
      await step(page, 1);
      await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 15_000 });
      await openWorkspace(page, "data");
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByTestId("sql-console")).toBeVisible();
      await page.getByTestId("sql-editor").fill("SELECT kind, count(*) AS n FROM trace_records GROUP BY kind ORDER BY kind");
      await page.getByTestId("sql-run").click();
      await expect(page.getByTestId("sql-status")).toContainText("rows", { timeout: 15_000 });
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await settle(page);
      const mask = [page.getByTestId("storage-info"), page.locator(".size-bar"), page.locator('[data-testid^="run-row-"]'), page.getByTestId("sql-status"), page.getByTestId("sql-grid")];
      await expect(page.getByTestId("workspace-data")).toHaveScreenshot(`data-workspace-${theme}.png`, { mask });
    });

    test("command palette", async ({ page }) => {
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette.locator(".group-head").first()).toBeVisible();
      await palette.getByRole("textbox", { name: "Command" }).fill("open panel");
      await expect(palette.getByRole("option").first()).toBeVisible();
      await settle(page);
      await expect(palette).toHaveScreenshot(`palette-${theme}.png`);
    });

    test("run popover", async ({ page }) => {
      await page.getByTestId("run-label").click();
      await expect(page.getByTestId("run-id")).toBeVisible();
      await settle(page);
      // The run's number depends on the order the tests ran in, the simulator's version carries the commit it was built from, and the planning prep is a wall-clock time.
      await expect(page.getByRole("dialog", { name: "Run" })).toHaveScreenshot(`run-popover-${theme}.png`, { mask: [page.getByTestId("run-id"), page.locator("dd", { hasText: /^\d+\.\d+\.\d+\+/ }), page.locator("dd", { hasText: / ms$/ })] });
    });

    test("Settings", async ({ page }) => {
      await openWorkspace(page, "settings");
      await settle(page);
      await expect(page.getByTestId("settings-panel")).toHaveScreenshot(`settings-${theme}.png`);
    });
  });
}
