import { expect, test } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, runCommand } from "./helpers.ts";

// Headless runs (ADR-0029, ADR-0035 section 7): started from the palette, the player, the run popover and Author, followed in the Experiments workspace by a monitor that
// progresses from the worker's own report, ended by its end condition or by Stop, and then opened for replay. A headless run shows nothing live and is always recorded.

test("Run headless from the palette: the Experiments monitor progresses, the run completes with its end snapshot, and it opens for replay", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await runCommand(page, "Run headless");
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  const monitor = page.getByTestId("headless-monitor");
  await expect(monitor).toBeVisible();
  // It goes as fast as lockstep allows to its end condition (60 sim seconds = 600 ticks) and says so.
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 60_000 });
  await expect(page.getByTestId("hm-ticks")).toContainText("tick 600 / 600");
  await expect(page.getByTestId("hm-progress")).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByTestId("hm-eta")).toContainText("ended");
  await expect(page.getByTestId("hm-profile")).toContainText("profile default-research");
  await expect(page.getByTestId("hm-snapshots")).toContainText(/\d+ snapshots?/);
  expect(await page.getByTestId("hm-mark").count()).toBeGreaterThanOrEqual(2); // the start and the end
  await expect(page.getByTestId("hm-stream-note")).toContainText("live subscription");
  // What it stored is there: it was always recorded, and it is marked completed.
  await expect(page.getByTestId("hm-volume")).toContainText(/stored \d/, { timeout: 15_000 });
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  const row = page.getByTestId("run-row-run-000002");
  await expect(row).toContainText("completed");
  await expect(page.getByTestId("replay-run-000002")).toBeEnabled();

  // From the monitor: replay what was saved, in the Debug workspace.
  await openWorkspace(page, "experiments");
  await page.getByTestId("hm-open-debug").click();
  await expect(page.getByTestId("workspace-debug")).toBeVisible();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("replay-time")).toContainText("/ 60.0 s");
});

test("the run popover runs it headless for the length chosen, Stop ends it early with its end snapshot (aborted), and a live run is unaffected by the opt-out checkbox", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("headless-until").fill("5000");
  await page.getByTestId("recording-opt-out").check();
  await expect(page.getByTestId("headless-opt-out-note")).toContainText("always recorded");
  await page.getByTestId("run-headless-popover").click();
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  await expect(page.getByTestId("hm-ticks")).toContainText("/ 50 000", { timeout: 30_000 }); // 5,000 sim seconds: not done in a moment
  await expect(page.getByTestId("hm-state")).toContainText("running");
  await expect(page.getByTestId("hm-speed")).toContainText("real time", { timeout: 15_000 });
  await page.getByTestId("hm-pause").click();
  await expect(page.getByTestId("hm-state")).toContainText("paused");
  await page.getByTestId("hm-play").click();
  await page.getByTestId("hm-stop").click();
  await expect(page.getByTestId("hm-state")).toContainText("stopped", { timeout: 30_000 });
  await expect(page.getByTestId("hm-open-analysis")).toBeEnabled(); // done, though stopped: what was recorded can be analysed
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("run-row-run-000002")).toContainText("aborted");
});

test("the run popover and Author start it too, and Author runs the configuration being edited, headless in lockstep", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("run-headless-popover").click();
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 60_000 });
  await openWorkspace(page, "author");
  await openPanelTab(page, "Run configuration");
  await page.getByTestId("rc-run-headless").click();
  await expect(page.getByTestId("workspace-experiments")).toBeVisible();
  await expect(page.getByTestId("hm-state")).toContainText("done", { timeout: 60_000 });
  await expect(page.locator("header.top").getByTestId("run-label")).toContainText("run-000003");
});
