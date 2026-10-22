import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openWorkspace, runCommand } from "./helpers.ts";

// F3b: the dock chrome (ADR-0042 §1, §7). Panels are numbered in their tabs; each has window buttons (float or dock, maximize, close) and a collapse for floating
// windows; all of it is also a palette command; the Performance window floats in every workspace, collapsed; a dock can be saved under a name and comes back.

type DockPanel = { id: string; title: string; location: string; maximized: boolean; collapsed: boolean; active: boolean };
const dock = (page: Page) => page.evaluate(() => (window.__agentsim?.dock?.() ?? []) as DockPanel[]);
const panel = async (page: Page, id: string) => (await dock(page)).find((p) => p.id === id);

test("panels are numbered in their tabs and every window button works by mouse", async ({ page }) => {
  await loadDemo(page);
  for (const name of ["[1] Scene 3D", "[2] Explorer", "[3] Inspector"]) await expect(page.getByRole("tab", { name })).toBeVisible();

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
  await runCommand(page, "Open panel: Scene 3D");
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
  // Debug has the Performance window inside its map; Author, Data and Settings have none until it is opened.
  await openWorkspace(page, "debug");
  await expect.poll(async () => (await panel(page, "perf"))?.location).toBe("floating");
  for (const id of ["author", "data", "settings"] as const) {
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
  await loadDemo(page);
  await page.getByTestId("wb-float-explorer").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("floating");

  await page.getByTestId("layout-save").click();
  await page.getByTestId("layout-name-input").fill("explorer floating");
  await page.getByTestId("layout-name-input").press("Enter");
  await expect(page.getByTestId("layout-select")).toHaveValue("explorer floating");

  // Change the dock, then load the saved one.
  await page.getByTestId("wb-dock-explorer").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("grid");
  await page.getByTestId("layout-select").selectOption("");
  await page.getByTestId("layout-select").selectOption("explorer floating");
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("floating");

  // The autosaved layout and the named one survive a reload.
  await expect.poll(() => page.evaluate(() => 1), { timeout: 1_000 }).toBe(1);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("workspace-scene")).toBeVisible();
  await expect.poll(async () => (await panel(page, "explorer"))?.location, { timeout: 15_000 }).toBe("floating");
  await expect(page.getByTestId("layout-select").locator("option")).toHaveText(["autosaved", "explorer floating"]);

  // Reset puts the preset back; the named layout is still there and can be deleted.
  await page.getByTestId("layout-reset").click();
  await expect.poll(async () => (await panel(page, "explorer"))?.location).toBe("grid");
  await page.getByTestId("layout-select").selectOption("explorer floating");
  await expect(page.getByTestId("layout-delete")).toBeVisible();
  await page.getByTestId("layout-delete").click();
  await expect(page.getByTestId("layout-select").locator("option")).toHaveText(["autosaved"]);
});
