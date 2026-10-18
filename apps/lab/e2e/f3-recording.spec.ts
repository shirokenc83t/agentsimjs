import { expect, test } from "@playwright/test";
import { loadDemo, openWorkspace, step } from "./helpers.ts";

// F3a M2 (T-013): a run is recorded by default. The recorder in the sim worker hands its records to the storage worker over a direct
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
