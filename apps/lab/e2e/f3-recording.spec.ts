import { expect, test } from "@playwright/test";
import { loadDemo, openWorkspace, runCommand, step, waitForStorageReady } from "./helpers.ts";

// F3a M2: a run is recorded by default. The recorder in the sim worker hands its records to the storage worker over a direct
// channel (they never pass through the main thread), the run waits for its header, and what the lab shows is what the storage holds.
test("a run is recorded by default: the storage holds at least every record the lab received, and no record is lost on the way", async ({ page }) => {
  await loadDemo(page);
  await step(page, 2); // 200 ticks
  await page.getByTestId("run-label").click();
  const runId = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  expect(runId).toMatch(/^run-\d{6}$/);
  const received = await page.evaluate(() => window.__agentsim?.records?.().length ?? 0);
  expect(received).toBeGreaterThan(0);
  await openWorkspace(page, "data");
  const row = page.getByTestId(`run-row-${runId}`);
  // The storage browser lists what is stored; it refreshes on demand. The flush follows the run within a moment. The storage holds at least
  // what the lab received (the Log's stream leaves out the pose samples the recorder also writes).
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    const stored = Number(await row.locator("td").nth(3).textContent());
    expect(stored).toBeGreaterThanOrEqual(received);
  }).toPass({ timeout: 10_000 });
});

// Agents with a belief map of their own (the F2 discovery demo starts them unknown) also record belief keyframes and deltas; the storage port refuses a
// frame that is not well formed, which stops the run (`recording_failed`): a run that explores must go on recording.
test("a run whose agents explore an unknown map records its belief frames without a recording error and is saved to the tick it is at", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await runCommand(page, "Load F2 discovery demo");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f2-discovery v\d+$/, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Explore selected agent (ugv-001)");
  await step(page, 4);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 400", { timeout: 15_000 });
  await expect(page.getByText(/recording_failed/)).toHaveCount(0);
});
