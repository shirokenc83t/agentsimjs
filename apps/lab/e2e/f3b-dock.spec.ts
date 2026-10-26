import { expect, test, type Page } from "@playwright/test";
import { layoutControls, loadDemo, openWorkspace, runCommand } from "./helpers.ts";

// F3b: the dock chrome (ADR-0042 §1, §7). Panels are numbered in their tabs; each has window buttons (float or dock, maximize, close) and a collapse for floating
// windows; all of it is also a palette command; the Performance window floats in every workspace, collapsed; a dock can be saved under a name and comes back.

type DockPanel = { id: string; title: string; location: string; maximized: boolean; collapsed: boolean; active: boolean };
const dock = (page: Page) => page.evaluate(() => (window.__agentsim?.dock?.() ?? []) as DockPanel[]);
const panel = async (page: Page, id: string) => (await dock(page)).find((p) => p.id === id);

test("panels are numbered in their tabs and every window button works by mouse", async ({ page }) => {
  await loadDemo(page);
  for (const name of ["[1] Scene", "[2] Explorer", "[3] Inspector"]) await expect(page.getByRole("tab", { name })).toBeVisible();

  await page.getByTestId("wb-float-explorer").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("floating");
  await page.getByTestId("wb-dock-explorer").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("grid");

  await page.getByTestId("wb-maximize-scene").click();
  await expect.poll(async () => (await panel(page, "scene"))?.maximized).toBe(true);
  await page.getByTestId("wb-maximize-scene").click();
  await expect.poll(async () => (await panel(page, "scene"))?.maximized).toBe(false);

  await page.getByTestId("wb-close-inspector").click();
  await expect.poll(async () => (await panel(page, "inspector")) === undefined).toBe(true);
  await runCommand(page, "Open panel: Inspector");
  await expect.poll(async () => (await panel(page, "inspector"))?.location).toBe("grid");
});

test("every panel action is a palette command, and Alt+number focuses a panel", async ({ page }) => {
  await loadDemo(page);
  await page.getByRole("tab", { name: "[2] Explorer" }).click();
  await expect.poll(async () => (await panel(page, "explorer"))?.active).toBe(true);

  await runCommand(page, "Float the active panel");
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("floating");
  await runCommand(page, "Dock the active panel");
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("grid");
  await runCommand(page, "Maximize or restore the active panel");
  await expect.poll(async () => (await panel(page, "explorer"))?.maximized).toBe(true);
  await runCommand(page, "Maximize or restore the active panel");
  await expect.poll(async () => (await panel(page, "explorer"))?.maximized).toBe(false);

  await runCommand(page, "Focus the next panel");
  await expect.poll(async () => (await panel(page, "explorer"))?.active).toBe(false);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("Alt+3");
  await expect.poll(async () => (await panel(page, "inspector"))?.active).toBe(true);
  await page.keyboard.press("Alt+1");
  await expect.poll(async () => (await panel(page, "scene"))?.active).toBe(true);

  await runCommand(page, "Close the active panel");
  await expect.poll(async () => (await panel(page, "scene")) === undefined).toBe(true);
  await runCommand(page, "Open panel: Scene");
  await expect.poll(async () => (await panel(page, "scene"))?.location).toBe("grid");
});

/** The box of a floating window (its resize container) and of the Scene's map area. */
async function boxes(page: Page, id: string) {
  const win = await page.getByTestId(`window-buttons-${id}`).locator("xpath=ancestor::div[contains(@class,'dv-resize-container')][1]").boundingBox();
  const map = await page.getByTestId("scene-canvas").boundingBox();
  return { win, map };
}

test("the floating windows sit inside the Scene's map, collapsed to their title; elsewhere the Performance window opens from the status bar", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  for (const id of ["perf", "overview", "legend"] as const) {
    await expect.poll(async () => (await panel(page, id))?.location).toBe("floating");
    expect((await panel(page, id))?.collapsed, `${id}: collapsed`).toBe(true);
    const { win, map } = await boxes(page, id);
    if (!win || !map) throw new Error(`no box for ${id}`);
    // Inside the map, and no wider than a title with its summary and its buttons.
    expect(win.x, `${id}: left`).toBeGreaterThanOrEqual(map.x);
    expect(win.x + win.width, `${id}: right`).toBeLessThanOrEqual(map.x + map.width + 1);
    expect(win.y, `${id}: top`).toBeGreaterThanOrEqual(map.y);
    expect(win.y + win.height, `${id}: bottom`).toBeLessThanOrEqual(map.y + map.height + 1);
    expect(win.width, `${id}: collapsed width`).toBeLessThanOrEqual(320);
  }
  // Open together, the Overview and the Legend do not cover each other.
  await page.getByTestId("wb-collapse-overview").click();
  await page.getByTestId("wb-collapse-legend").click();
  await expect.poll(async () => (await panel(page, "legend"))?.collapsed).toBe(false);
  await expect.poll(async () => (await panel(page, "overview"))?.collapsed).toBe(false);
  const both = { o: (await boxes(page, "overview")).win, l: (await boxes(page, "legend")).win, map: (await boxes(page, "legend")).map };
  if (!both.o || !both.l || !both.map) throw new Error("no boxes");
  const apart = both.o.x + both.o.width <= both.l.x + 1 || both.l.x + both.l.width <= both.o.x + 1 || both.o.y + both.o.height <= both.l.y + 1 || both.l.y + both.l.height <= both.o.y + 1;
  expect(apart, `overview ${JSON.stringify(both.o)} against legend ${JSON.stringify(both.l)}`).toBe(true);
  expect(both.o.x, "overview inside the map").toBeGreaterThanOrEqual(both.map.x);
  await page.getByTestId("wb-collapse-overview").click();
  await page.getByTestId("wb-collapse-legend").click();

  // Debug has the Performance window inside its map; Author, Data and Settings have none until it is opened.
  await openWorkspace(page, "debug");
  await expect.poll(async () => (await panel(page, "perf"))?.location).toBe("floating");
  for (const id of ["configurations", "data", "settings"] as const) {
    await openWorkspace(page, id);
    await expect.poll(async () => (await panel(page, "perf")) === undefined, { message: `${id}: no Performance window` }).toBe(true);
  }
  await page.getByTestId("status-frame").click();
  await expect.poll(async () => (await panel(page, "perf"))?.location).toBe("floating");
  await expect.poll(async () => (await panel(page, "perf"))?.collapsed).toBe(false);
  await expect(page.getByTestId("perf-hud")).toBeVisible();

  // In the Scene: opened and collapsed with its button; closed, it comes back from the palette.
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("perf-hud")).toBeHidden();
  await page.getByTestId("wb-collapse-perf").click();
  await expect(page.getByTestId("perf-hud")).toBeVisible();
  await expect.poll(async () => (await panel(page, "perf"))?.collapsed).toBe(false);
  await page.getByTestId("wb-collapse-perf").click();
  await expect(page.getByTestId("perf-hud")).toBeHidden();
  await page.getByTestId("wb-close-perf").click();
  await expect.poll(async () => (await panel(page, "perf")) === undefined).toBe(true);
  await runCommand(page, "Open panel: Performance");
  await expect.poll(async () => (await panel(page, "perf"))?.location).toBe("floating");
});

test("a floating window's title bar is a grip, the title, a summary and three labelled buttons: collapse, dock, close", async ({ page }) => {
  test.setTimeout(60_000);
  await loadDemo(page);
  const bar = page.getByTestId("window-buttons-perf");
  await expect(bar.getByRole("button")).toHaveCount(3);
  for (const name of ["Open Performance", "Dock Performance", "Close Performance"]) await expect(bar.getByRole("button", { name })).toBeVisible();
  await expect(page.getByTestId("window-buttons-perf").getByTestId("panel-context")).toContainText(/fps|no frames/);
  // No second close on the tab, and no overflow control, in a floating window.
  const container = bar.locator("xpath=ancestor::div[contains(@class,'dv-resize-container')][1]");
  await expect(container.locator(".dv-default-tab-action")).toBeHidden();
  await expect(container.locator(".dv-tabs-overflow-dropdown-default")).toBeHidden();
  // The glyph of a state is not a button: no ✓ in the title bar.
  expect(await container.locator(".dv-tabs-and-actions-container").first().textContent()).not.toContain("✓");
});

test("a dock saved under a name comes back, and it stays after a reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 }); // wide enough that the layout controls are in the bar, not folded (they grow with a name and a delete button)
  await loadDemo(page);
  await page.getByTestId("wb-float-explorer").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("floating");

  await layoutControls(page);
  await page.getByTestId("layout-save").click();
  await layoutControls(page);
  await page.getByTestId("layout-name-input").fill("explorer floating");
  await layoutControls(page);
  await page.getByTestId("layout-name-input").press("Enter");
  await layoutControls(page);
  await expect(page.getByTestId("layout-select")).toHaveValue("explorer floating");

  // Change the dock, then load the saved one.
  await page.getByTestId("wb-dock-explorer").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("grid");
  await layoutControls(page);
  await page.getByTestId("layout-select").selectOption("");
  await layoutControls(page);
  await page.getByTestId("layout-select").selectOption("explorer floating");
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("floating");

  // The autosaved layout and the named one survive a reload.
  await expect.poll(() => page.evaluate(() => 1), { timeout: 1_000 }).toBe(1);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("workspace-scene")).toBeVisible();
  await expect.poll(async () => (await panel(page, "explorer"))?.location, { timeout: 15_000 }).toBe("floating");
  await layoutControls(page);
  await expect(page.getByTestId("layout-select").locator("option")).toHaveText(["autosaved", "explorer floating"]);

  // Reset puts the preset back; the named layout is still there and can be deleted.
  await layoutControls(page);
  await page.getByTestId("layout-reset").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("grid");
  await layoutControls(page);
  await page.getByTestId("layout-select").selectOption("explorer floating");
  await layoutControls(page);
  await expect(page.getByTestId("layout-delete")).toBeVisible();
  await layoutControls(page);
  await page.getByTestId("layout-delete").click();
  await layoutControls(page);
  await expect(page.getByTestId("layout-select").locator("option")).toHaveText(["autosaved"]);
});

test("a workspace's only panel can be floated, docked back with its button, closed and brought back by Reset layout; Reset layout restores the preset of Experiments and of Data", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await openWorkspace(page, "experiments");
  await expect.poll(async () => (await panel(page, "headlessMonitor"))?.location).toBe("grid");

  // Floated, the grid is empty: the dock button still puts the monitor back where the preset has it.
  await page.getByTestId("wb-float-headlessMonitor").click();
  await expect.poll(async () => (await panel(page, "headlessMonitor"))?.location).toBe("floating");
  await page.getByTestId("wb-dock-headlessMonitor").click();
  await expect.poll(async () => (await panel(page, "headlessMonitor"))?.location).toBe("grid");

  // Floated again, Reset layout restores the preset; closed, it brings the panel back.
  await page.getByTestId("wb-float-headlessMonitor").click();
  await expect.poll(async () => (await panel(page, "headlessMonitor"))?.location).toBe("floating");
  await layoutControls(page);
  await page.getByTestId("layout-reset").click();
  await expect.poll(async () => (await panel(page, "headlessMonitor"))?.location).toBe("grid");
  await page.getByTestId("wb-close-headlessMonitor").click();
  await expect.poll(async () => (await panel(page, "headlessMonitor")) === undefined).toBe(true);
  await runCommand(page, "Reset layout");
  await expect.poll(async () => (await panel(page, "headlessMonitor"))?.location).toBe("grid");
  await expect(page.getByTestId("headless-monitor")).toBeVisible();

  // Another workspace: Data, with its two panels; one floated and one closed, Reset layout puts both back in the grid.
  await openWorkspace(page, "data");
  await page.getByTestId("wb-float-storage").click();
  await expect.poll(async () => (await panel(page, "storage"))?.location).toBe("floating");
  await page.getByTestId("wb-close-sqlConsole").click();
  await layoutControls(page);
  await page.getByTestId("layout-reset").click();
  await expect.poll(async () => (await panel(page, "storage"))?.location).toBe("grid");
  await expect.poll(async () => (await panel(page, "sqlConsole"))?.location).toBe("grid");
});

test("the Debug has two layouts that ship with it, 'debug · default' and 'debug · two columns': proportions, the layout menu, Alt+L, savable under a name, and Reset goes back to the default", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await openWorkspace(page, "debug");
  // A panel may be remounted while the dock lays out: look again for a moment before saying it is not there.
  const box = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      const b = await page.getByTestId(id).boundingBox({ timeout: 1000 }).catch(() => null);
      if (b) return b;
      await page.waitForTimeout(100);
    }
    throw new Error(`no ${id}`);
  };
  const dock = async () => {
    const b = await page.locator(".dv-dockview").first().boundingBox();
    if (!b) throw new Error("no dock");
    return b;
  };
  // The default: the right column is about 38 % of the dock, the Log above the Trace above the Inspector.
  await expect.poll(async () => Math.abs((await box("event-list")).width / (await dock()).width - 0.38)).toBeLessThan(0.04);
  const [log, trace, inspector] = [await box("event-list"), await box("trace-tree"), await box("inspector")];
  expect(log.y).toBeLessThan(trace.y);
  expect(trace.y).toBeLessThan(inspector.y);
  expect(log.height).toBeGreaterThan(trace.height); // 46 % against 24 %

  // Two columns: the Scene and the Timeline about 46 %, the Log full height (at least 420 px) next to them, the Trace over the Inspector in the last 26 %.
  await layoutControls(page);
  await expect(page.getByTestId("layout-select").locator("option")).toHaveText(["autosaved", "debug · default", "debug · two columns", "debug · logs"]);
  await layoutControls(page);
  await page.getByTestId("layout-select").selectOption("debug · two columns");
  await expect.poll(async () => (await box("event-list")).width).toBeGreaterThanOrEqual(405); // the group is 420 px; its content is a little less
  const two = { log: await box("event-list"), trace: await box("trace-tree"), inspector: await box("inspector"), d: await dock() };
  expect(Math.abs(two.log.width / two.d.width - 0.28)).toBeLessThan(0.06);
  expect(two.log.height).toBeGreaterThan(two.trace.height + two.inspector.height); // the Log is the whole height of its column
  expect(two.trace.y).toBeLessThan(two.inspector.y);
  expect(two.trace.x).toBeGreaterThan(two.log.x + two.log.width - 4);

  // Alt+L goes to the next layout of the workspace; it wraps to the default, and the menu shows where it is.
  await page.keyboard.press("Alt+L");
  await layoutControls(page);
  await expect(page.getByTestId("layout-select")).toHaveValue("debug · default");
  await expect.poll(async () => Math.abs((await box("event-list")).width / (await dock()).width - 0.38)).toBeLessThan(0.04);
  await runCommand(page, "Layout: debug · two columns");
  await layoutControls(page);
  await expect(page.getByTestId("layout-select")).toHaveValue("debug · two columns");

  // It can be saved under a name (a layout that ships is not a named one), and Reset goes back to the workspace's own preset.
  await layoutControls(page);
  await expect(page.getByTestId("layout-save")).toBeEnabled();
  await layoutControls(page);
  await page.getByTestId("layout-reset").click();
  await expect.poll(async () => Math.abs((await box("event-list")).width / (await dock()).width - 0.38)).toBeLessThan(0.04);
  await layoutControls(page);
  await expect(page.getByTestId("layout-select")).toHaveValue("");
});
