import { expect, test } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, step, waitForStorageReady } from "./helpers.ts";

// F3b M1 review: the Author conditions. The brush is a window the researcher can fold and move, and it starts folded at a corner; the JSON view of the run
// configuration folds and resizes; the scope select says how many values are set; numbers are typed with a dot; the run popover offers a replay of a stored run.

test("the brush window starts folded, opens, and moves inside the map's area", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "configurations");
  await page.getByTestId("ed-new").click();
  await page.getByTestId("ed-new-id").fill("brush-yard");
  await page.getByTestId("ed-new-create").click();
  const win = page.getByTestId("ed-brush-window");
  await expect(win).toBeVisible();
  await expect(page.getByTestId("ed-brush")).toBeHidden();
  const folded = await win.boundingBox();
  expect(folded?.height).toBeLessThan(40);
  await page.getByTestId("ed-brush-toggle").click();
  await expect(page.getByTestId("ed-brush")).toBeVisible();
  // Dragged by its title bar, it follows and stays inside the map's area.
  const view = await page.locator(".editor-view").boundingBox();
  const before = await win.boundingBox();
  if (!view || !before) throw new Error("no boxes");
  await page.mouse.move(before.x + 40, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x - 200, before.y + 150, { steps: 6 });
  await page.mouse.move(view.x - 500, view.y + view.height + 500, { steps: 6 });
  await page.mouse.up();
  const after = await win.boundingBox();
  if (!after) throw new Error("no box");
  expect(after.x).toBeGreaterThanOrEqual(view.x - 1);
  expect(after.x + after.width).toBeLessThanOrEqual(view.x + view.width + 1);
  expect(after.y).toBeLessThanOrEqual(view.y + view.height);
  expect(after.x).not.toBe(before.x);
  await page.getByTestId("ed-brush-toggle").click();
  await expect(page.getByTestId("ed-brush")).toBeHidden();
});

test("Run configuration: the JSON view folds and resizes, and the scope select counts what is set", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const json = page.getByRole("complementary", { name: "Text view" });
  await expect(json).toBeVisible();
  const w0 = (await json.boundingBox())?.width ?? 0;
  await page.getByTestId("rc-json-split").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await json.boundingBox())?.width ?? 0).toBeGreaterThan(w0 + 20);
  await page.getByTestId("rc-json-toggle").click();
  await expect(json).toBeHidden();
  await page.getByTestId("rc-json-toggle").click();
  await expect(json).toBeVisible();

  // Numbers are typed with a dot; the scope select counts what is set at the level.
  await page.getByTestId("rc-explore-radius").fill("12.5");
  await expect(page.getByTestId("rc-explore-radius")).toHaveValue("12.5");
  await expect(page.getByTestId("rc-planning-scope").locator("option").first()).toHaveText("default (all agents) · 1 set");
});

test("the run popover lists a stored run with a replay link that shows it from storage", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await step(page, 1);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 20_000 });
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("rerun")).toHaveClass(/\bpri\b/);
  const link = page.locator('[data-testid^="replay-stored-"]').first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(page.getByRole("dialog", { name: "Run" })).toHaveCount(0);
  await expect(page.getByTestId("replay-segment")).toContainText("◷ REPLAY", { timeout: 30_000 });
});
