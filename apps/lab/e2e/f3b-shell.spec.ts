import { expect, test } from "@playwright/test";
import { loadDemo, step } from "./helpers.ts";

// F3b: the shell (UI-SPEC §2). Keys 1–5 open the workspaces, Space plays and pauses, `.` steps one tick; while a recording is shown the top bar keeps a ◷ REPLAY
// segment, the player is hatched and the status bar says that the live run goes on behind it.

test("1–5 open the workspaces, Space plays and pauses, the dot steps one tick", async ({ page }) => {
  await loadDemo(page);
  for (const [key, id] of [["2", "debug"], ["3", "author"], ["4", "data"], ["5", "settings"], ["1", "scene"]] as const) {
    await page.keyboard.press(key);
    await expect(page.getByTestId(`workspace-${id}`)).toBeVisible();
    await expect(page.getByTestId(`tab-${id}`)).toHaveAttribute("aria-current", "page");
  }

  await expect(page.getByTestId("play")).toBeVisible(); // a loaded run is paused at tick 0
  // Focus is on the control that closed the run popover (Space would press it): move it off, as a click on the page would.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("Space");
  await expect(page.getByTestId("pause")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("play")).toBeVisible();

  const tick = async () => Number(((await page.getByTestId("status-tick").textContent()) ?? "").replace("tick ", ""));
  await expect.poll(tick).toBeGreaterThanOrEqual(0);
  const before = await tick();
  await page.keyboard.press(".");
  await expect.poll(tick).toBe(before + 1);
});

test("keys typed in a field are the field's, not the shell's", async ({ page }) => {
  await loadDemo(page);
  await page.keyboard.press("5");
  await expect(page.getByTestId("workspace-settings")).toBeVisible();
  const quota = page.getByRole("spinbutton").first();
  await quota.fill("");
  await quota.press("1");
  await quota.press("Space");
  await expect(page.getByTestId("workspace-settings")).toBeVisible(); // not switched to Scene
  await expect(page.getByTestId("play")).toBeVisible(); // not started
});

test("a recording shown in the player: the ◷ REPLAY segment, the hatched band and the live run in the background", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await step(page, 1);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 20_000 });
  await expect(page.getByTestId("replay-segment")).toHaveCount(0);
  await expect(page.getByTestId("status-live-background")).toHaveCount(0);
  await expect(page.getByTestId("player-state")).toHaveText("● LIVE");

  await page.getByTestId("scrub-back").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("replay-segment")).toContainText("◷ REPLAY");
  await expect(page.getByTestId("status-live-background")).toContainText("live run in background");
  await expect(page.getByTestId("player")).toHaveClass(/\brp\b/);
  await expect(page.getByTestId("player-state")).toContainText("◷ REPLAY");

  await page.getByTestId("replay-close").click();
  await expect(page.getByTestId("replay-segment")).toHaveCount(0);
  await expect(page.getByTestId("status-live-background")).toHaveCount(0);
  await expect(page.getByTestId("player")).not.toHaveClass(/\brp\b/);
});

test("the player is one row in Author, Data and Settings", async ({ page }) => {
  await loadDemo(page);
  const full = (await page.getByTestId("player").boundingBox())?.height ?? 0;
  await page.keyboard.press("3");
  await expect(page.getByTestId("workspace-author")).toBeVisible();
  const compact = (await page.getByTestId("player").boundingBox())?.height ?? 0;
  expect(full).toBeGreaterThanOrEqual(54);
  expect(compact).toBeLessThanOrEqual(42);
  expect((await page.getByTestId("topbar").boundingBox())?.height).toBeCloseTo(28, 0);
  expect((await page.getByTestId("statusline").boundingBox())?.height).toBeCloseTo(24, 0);
});
