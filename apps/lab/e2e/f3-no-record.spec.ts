import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, step, waitForStorageReady } from "./helpers.ts";

// F3a M2 (T-016): "Don't record this run" is the researcher's explicit choice for one run: labelled `○ not recorded` in the status line, nothing of it
// stored, and it runs exactly as a recorded one (the same state hash). The run after it is recorded again (ADR-0035 addition of 2026-10-17, item 6).

async function openRun(page: Page) {
  await page.getByTestId("run-label").click();
  await expect(page.getByRole("dialog", { name: "Run" })).toBeVisible();
}

async function hashAt100(page: Page): Promise<string> {
  await step(page, 1);
  await openRun(page);
  await expect(page.getByTestId("state-hash")).toHaveText(/^[0-9a-f]{8} @ tick 100$/);
  const text = (await page.getByTestId("state-hash").textContent()) ?? "";
  await page.keyboard.press("Escape");
  return text.slice(0, 8);
}

test("a run that is not recorded is labelled so, has the hash of a recorded one, stores no record, and the next run is recorded again", async ({ page }) => {
  await page.goto("/?probe");
  await waitForStorageReady(page);

  // A recorded run first: its hash at tick 100.
  await openRun(page);
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  const recordedId = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-recording")).toContainText("● recording");
  const recordedHash = await hashAt100(page);

  // The same scenario and configuration, opted out.
  await openRun(page);
  await page.getByTestId("recording-opt-out").check();
  await expect(page.getByTestId("recording-opt-out-note")).toBeVisible();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(recordedId);
  const optedOutId = (await page.getByTestId("run-id").textContent()) ?? "";
  await expect(page.getByTestId("run-recording")).toHaveText("○ not recorded");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-recording")).toHaveText("○ not recorded");
  await expect(page.getByTestId("status-recording-saved")).toHaveCount(0);
  const optedOutHash = await hashAt100(page);
  expect(optedOutHash).toBe(recordedHash); // observation only: the run is the same
  // The Log still shows the run's records (its cache), the storage holds none of them.
  expect(await page.evaluate(() => window.__agentsim?.records?.().length ?? 0)).toBeGreaterThan(0);
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId(`run-row-${optedOutId}`)).toContainText("0");
  await expect(page.getByTestId(`run-size-${optedOutId}`)).toContainText("records 0");
  await expect(page.getByTestId(`run-size-${optedOutId}`)).toContainText("snapshots 0");
  expect(Number((await page.getByTestId(`run-row-${recordedId}`).locator("td").nth(3).textContent()) ?? "0")).toBeGreaterThan(0);

  // The opt-out was for that run only: the next one is recorded.
  await openRun(page);
  await expect(page.getByTestId("recording-opt-out")).not.toBeChecked();
  await page.getByTestId("rerun").click();
  await expect(page.getByTestId("run-recording")).toHaveText(/^default-research · /);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-recording")).toContainText("● recording default-research");
});
