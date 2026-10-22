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

test("the Performance window floats in every workspace, collapsed until it is opened", async ({ page }) => {
  await loadDemo(page);
  for (const id of ["scene", "debug", "author", "data", "settings"] as const) {
    await openWorkspace(page, id);
    await expect.poll(async () => (await panel(page, "perf"))?.location).toBe("floating");
    expect((await panel(page, "perf"))?.collapsed, `${id}: collapsed`).toBe(true);
  }
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("perf-hud")).toBeHidden();
  await page.getByTestId("wb-collapse-perf").click();
  await expect(page.getByTestId("perf-hud")).toBeVisible();
  await expect.poll(async () => (await panel(page, "perf"))?.collapsed).toBe(false);
  await page.getByTestId("wb-collapse-perf").click();
  await expect(page.getByTestId("perf-hud")).toBeHidden();
  // A window that was collapsed by hand and closed comes back from the palette.
  await page.getByTestId("wb-close-perf").click();
  await expect.poll(async () => (await panel(page, "perf")) === undefined).toBe(true);
  await runCommand(page, "Open panel: Performance");
  await expect.poll(async () => (await panel(page, "perf"))?.location).toBe("floating");
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
