import { expect, test } from "@playwright/test";
import { loadDemo, openWorkspace, waitForStorageReady } from "./helpers.ts";

// F3b: Data, Settings, the palette and the run popover (ADR-0042): gauges and labelled actions, sections and switches, grouped results with keys, a popover with an edge.

test("the palette groups its results, marks the matched letters, shows keys and has the theme commands", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await waitForStorageReady(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette.locator(".group-head").first()).toBeVisible();
  await expect(palette.locator("kbd", { hasText: "Space" }).first()).toBeVisible();
  await palette.getByRole("textbox", { name: "Command" }).fill("theme light");
  await expect(palette.locator("mark").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("Settings: sections with a rail, the theme as a segmented control, reduced motion and the dock grid, the keys listed", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  const panel = page.getByTestId("settings-panel");
  await expect(panel.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await expect(panel).toContainText("Minimum quota");
  await expect(panel).toContainText("play or pause");
  // A key is only ever “set” or “not set”: there is nothing to type here yet.
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  await page.getByTestId("setting-reduced-motion").check();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await page.getByTestId("setting-dock-grid").uncheck();
  await expect(page.locator("html")).toHaveAttribute("data-dockgrid", "off");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await expect(page.locator("html")).toHaveAttribute("data-dockgrid", "off");
  await waitForStorageReady(page);
  await openWorkspace(page, "settings");
  await page.getByTestId("setting-reduced-motion").uncheck();
  await expect(page.locator("html")).not.toHaveAttribute("data-motion", "reduce");
});

test("Data: gauges, a labelled action per row, the size by kind, and a delete dialog that offers to export first", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await waitForStorageReady(page);
  await openWorkspace(page, "data");
  await page.getByTestId("create-sample-run").click();
  const row = page.locator('[data-testid^="run-row-"]').first();
  await expect(row).toContainText("⭳ .sqlite");
  await expect(row).toContainText("✕ delete");
  await expect(row.locator(".size-bar")).toBeVisible();
  await expect(page.getByTestId("storage-info")).toContainText("PERSISTENT");
  await row.getByRole("button", { name: /^Delete run-/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Export first" })).toBeVisible();
  // It floats over a scrim, over the whole app.
  expect((await dialog.boundingBox())?.width).toBeLessThan(500);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the run popover has an edge, closes on Escape and gives the focus back", async ({ page }) => {
  test.setTimeout(90_000);
  await loadDemo(page);
  const trigger = page.getByTestId("run-label");
  await trigger.click();
  const pop = page.getByRole("dialog", { name: "Run" });
  await expect(pop).toBeVisible();
  expect(await pop.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("1px");
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("there is a favicon", async ({ page }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toBeTruthy();
  expect((await page.request.get(href ?? "/favicon.svg")).ok()).toBe(true);
});
