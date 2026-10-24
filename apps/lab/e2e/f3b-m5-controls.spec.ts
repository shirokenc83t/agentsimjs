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
