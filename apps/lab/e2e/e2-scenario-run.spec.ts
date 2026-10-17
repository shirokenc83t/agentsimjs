import { expect, test, type Page } from "@playwright/test";
import { runCommand, waitForStorageReady } from "./helpers.ts";

async function openRun(page: Page) {
  await page.getByTestId("run-label").click();
  await expect(page.getByRole("dialog", { name: "Run" })).toBeVisible();
}

async function closeRun(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Run" })).toHaveCount(0);
}

/** Steps 100 ticks from the palette and returns the state hash shown in the run header at tick 100. */
async function hashAt100(page: Page): Promise<string> {
  await runCommand(page, "Step 100 ticks");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 100");
  await openRun(page);
  await expect(page.getByTestId("state-hash")).toHaveText(/^[0-9a-f]{8} @ tick 100$/);
  const text = (await page.getByTestId("state-hash").textContent()) ?? "";
  await closeRun(page);
  return text.slice(0, 8);
}

// F1 e2: the lab runs the real world. A scenario run is loaded from the UI, its reproducibility header is
// visible (ADR-0028), and the determinism criterion is shown from the UI: the same scenario version and run
// configuration give the same state hash after N steps, in a new run.
test("loads the F1 demo as a run with its header; a re-run reaches the same state hash after 100 ticks", async ({ page }) => {
  await page.goto("/");
  await waitForStorageReady(page);
  await openRun(page);
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  const firstRun = (await page.getByTestId("run-id").textContent()) ?? "";
  expect(firstRun).toMatch(/^run-\d{6}$/);
  await expect(page.getByTestId("run-config-hash")).toHaveText(/^[0-9a-f]{8}$/);
  await expect(page.getByTestId("effective-config-hash")).toHaveText(/^[0-9a-f]{8}$/);
  // The F1 demo runs its three agents on ground truth, labelled in the header (ADR-0028 addition of 2026-10-10).
  await expect(page.getByTestId("ideal-agents")).toHaveText(/^(uav|ugv)-\d{3}(, (uav|ugv)-\d{3}){2}$/);
  await expect(page.getByTestId("simulator-version")).toHaveText(/^\d+\.\d+\.\d+\+([0-9a-f]{7,}|unknown)(-dirty)?$/);
  await closeRun(page);
  // The three demo agents replace the F0 placeholder; the run starts paused at tick 0.
  await expect(page.getByTestId("statusline")).toContainText("3 entities");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");

  const h1 = await hashAt100(page);

  await openRun(page);
  await page.getByTestId("rerun").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(firstRun);
  const scenario = await page.getByTestId("run-scenario").textContent();
  await closeRun(page);
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  const h2 = await hashAt100(page);
  expect(h2).toBe(h1);

  // Loading the demo again stores no new scenario version (the document did not change).
  await openRun(page);
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(scenario ?? "");
});
