import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openWorkspace } from "./helpers.ts";

// F3b M5 (the maintainer's manual check): the theme control of the top bar, and the canvases that draw with the tokens (the top-down map, the Timeline) follow a change of theme.

/** The colour of a pixel of a canvas, as [r, g, b]. */
async function pixel(page: Page, testId: string, x: number, y: number): Promise<number[]> {
  return page.getByTestId(testId).evaluate((c: HTMLCanvasElement, at) => Array.from(c.getContext("2d")?.getImageData(at.x, at.y, 1, 1).data ?? []).slice(0, 3), { x, y });
}
const luminance = (rgb: number[]) => 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);

test("the theme button and Ctrl+Shift+L change the theme, and the map and the Timeline redraw with the new tokens", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => window.localStorage.setItem("agentsim.ui.theme", "dark"));
  await loadDemo(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // The Scene's 2D view is the same canvas as the Analysis map: its background is the dark token.
  await page.getByTestId("map-view-2d").click();
  await expect(page.getByTestId("map2d-canvas")).toBeVisible();
  await expect.poll(async () => luminance(await pixel(page, "map2d-canvas", 2, 2))).toBeLessThan(90);

  // The menu: dark, light, system; the current one is checked.
  await page.getByTestId("theme-button").click();
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // The canvas is drawn again with the light tokens, not left in the colours it read once.
  await expect.poll(async () => luminance(await pixel(page, "map2d-canvas", 2, 2))).toBeGreaterThan(160);

  // Ctrl+Shift+L toggles back, from anywhere.
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => luminance(await pixel(page, "map2d-canvas", 2, 2))).toBeLessThan(90);

  // The Timeline of the Debug workspace follows too.
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  const dark = luminance(await pixel(page, "timeline-canvas", 40, 25));
  await page.getByTestId("theme-button").click();
  await page.getByTestId("theme-light").click();
  await expect.poll(async () => luminance(await pixel(page, "timeline-canvas", 40, 25))).toBeGreaterThan(dark + 60);
});

test("when the top bar is too narrow the layout controls fold into one `layout ▾` first: the theme button and ctrl+k stay, and the menu has the same controls", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1000, height: 700 });
  await loadDemo(page);
  await expect(page.getByTestId("layout-fold")).toBeVisible();
  await expect(page.getByTestId("layout-select")).toHaveCount(0);
  await expect(page.getByTestId("theme-button")).toBeVisible();
  await expect(page.getByLabel("Command palette").first()).toBeVisible();
  const right = async (id: string) => {
    const b = await page.getByTestId(id).boundingBox();
    return (b?.x ?? 0) + (b?.width ?? 0);
  };
  expect(await right("theme-button")).toBeLessThanOrEqual(1000);
  await page.getByTestId("layout-fold").click();
  await expect(page.getByTestId("layout-menu")).toBeVisible();
  await expect(page.getByTestId("layout-select")).toBeVisible();
  await expect(page.getByTestId("layout-save")).toBeVisible();
  await expect(page.getByTestId("layout-reset")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("layout-menu")).toHaveCount(0);
  // With room again the controls are back in the bar.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.getByTestId("layout-fold")).toHaveCount(0);
  await expect(page.getByTestId("layout-select")).toBeVisible();
});
