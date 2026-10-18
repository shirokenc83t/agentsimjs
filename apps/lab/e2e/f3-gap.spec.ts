import { expect, test, type Page } from "@playwright/test";
import { sceneSettled, step, waitForStorageReady } from "./helpers.ts";

// F3a M3 (T-023, ADR-0035 addition of 2026-10-17, item 12): a live recorded run can be scrubbed back up to its persisted head. With the test-only slow writer the
// storage is behind the sim: the Timeline shows the gap, a click in it lands on the persisted head with a notice and no error, and once the writer has caught up
// the same click lands on its moment.

async function clickTrack(page: Page, fraction: number) {
  const box = await page.getByTestId("replay-track").boundingBox();
  if (!box) throw new Error("no timeline");
  await page.getByTestId("replay-track").click({ position: { x: box.width * fraction, y: box.height / 2 } });
}

test("a live run is scrubbed up to its persisted head: the gap is shown, a click in it lands on the head, after the flush the same click lands on its moment", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?probe&simulate-slow-writer=4000");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  await page.keyboard.press("Escape");
  await sceneSettled(page);
  await step(page, 1); // the sim is at tick 100 (10 s)

  // Scrub back (the reads wait for the slow writer's commits, so by the time it opens, tick 100 is saved), then let the run go on: 100 more ticks that the writer has not saved.
  await page.getByTestId("scrub-back").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("replay-label")).toContainText("Scrubbing");
  await expect(page.getByTestId("replay-time")).toContainText("/ 10.0 s");
  await step(page, 1); // the sim is at tick 200 (20 s); the writer is 4 s a commit behind
  await expect(page.getByTestId("replay-gap")).toHaveText(/^not saved yet: \d+ ticks \(\d+\.\d s\)$/);
  await expect(page.getByTestId("replay-gap-area")).toBeVisible();
  await expect(page.getByTestId("replay-follow")).toBeChecked(); // the cursor starts on the persisted head

  // A click in the gap: the persisted head, with the notice, no error.
  await clickTrack(page, 0.9);
  await expect(page.getByTestId("replay-notice")).toContainText("Not saved yet");
  const held = (await page.getByTestId("replay-time").textContent()) ?? "";
  const heldAt = Number(/^([\d.]+) s/.exec(held)?.[1] ?? "NaN");
  expect(heldAt).toBeLessThan(18);
  await expect(page.getByTestId("replay-error")).toHaveCount(0);
  await expect(page.getByTestId("replay-follow")).not.toBeChecked();

  // The writer catches up: the gap goes, and the same click lands on its moment.
  await expect(page.getByTestId("replay-gap")).toHaveCount(0, { timeout: 30_000 });
  await clickTrack(page, 0.9);
  await expect(page.getByTestId("replay-time")).toContainText("18.0 s /");
  await expect(page.getByTestId("replay-notice")).toHaveCount(0);

  // Follow saved: the cursor goes to the persisted head, and "Live" gives the panels the run back.
  await page.getByTestId("replay-follow").check();
  await expect(page.getByTestId("replay-time")).toContainText("20.0 s / 20.0 s");
  await page.getByTestId("replay-close").click();
  await expect(page.getByTestId("replay-bar")).toHaveCount(0);
  await expect(page.getByTestId("scrub-back")).toBeVisible();
});
