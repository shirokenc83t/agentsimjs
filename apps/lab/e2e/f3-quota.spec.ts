import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, runCommand, step, waitForStorageReady } from "./helpers.ts";

// F3a M2: when storage nears its quota the run pauses as `storage_quota`, with the state shown in the status line, and it goes on when
// space is freed: here by deleting an old run in the Storage browser (ADR-0035 §6 and addition of 2026-10-17, item 7). The quota is simulated
// (`?simulate-quota-headroom=`: what the database holds when it opens, plus a little).

async function openRun(page: Page) {
  await page.getByTestId("run-label").click();
  await expect(page.getByRole("dialog", { name: "Run" })).toBeVisible();
}

test("a run pauses as storage_quota near the quota and goes on once an old run is deleted; the run being recorded cannot be deleted", async ({ page }) => {
  test.setTimeout(120_000);
  // An old run with some data in it.
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openRun(page);
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  const oldId = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await step(page, 8); // 800 ticks: poses, checkpoints, a periodic snapshot
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 800", { timeout: 10_000 });

  // The same database, with a quota only a little above what it holds.
  await page.goto("/?probe&simulate-quota-headroom=40000");
  await waitForStorageReady(page);
  await openRun(page);
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(oldId);
  const newId = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");

  // Step until the run pauses for the quota (a step that cannot finish waits for the space).
  const state = page.getByTestId("status-recording-state");
  for (let i = 0; i < 40 && !(await state.isVisible()); i++) {
    await runCommand(page, "Step 100 ticks");
    await page.waitForTimeout(400);
  }
  await expect(state).toBeVisible();
  await expect(state).toContainText("storage quota");
  const tickText = (await page.getByTestId("status-tick").textContent()) ?? "";
  const stuckAt = Number(tickText.replace("tick ", ""));
  // A step asked for now waits for the space: no tick while the quota is near.
  await runCommand(page, "Step 100 ticks");
  await page.waitForTimeout(800);
  await expect(page.getByTestId("status-tick")).toHaveText(`tick ${stuckAt}`);

  // The Storage browser lists both runs with what they hold; the run being recorded cannot be deleted, the old one can.
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId(`run-size-${oldId}`)).toContainText("records");
  await expect(page.getByRole("button", { name: `Delete ${newId}` })).toBeDisabled();
  await page.getByRole("button", { name: `Delete ${oldId}` }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(oldId);
  await expect(dialog).toContainText(/\d+(\.\d+)? (B|KB|MB)/);
  await dialog.getByRole("button", { name: "Delete the run" }).click();
  await expect(page.getByTestId("storage-message")).toContainText(`deleted ${oldId}`);
  await expect(page.getByTestId(`run-row-${oldId}`)).toHaveCount(0);

  // Space is free again: the run goes on, and the state is gone from the status line.
  await expect(state).toHaveCount(0, { timeout: 15_000 });
  await expect(async () => {
    const t = Number(((await page.getByTestId("status-tick").textContent()) ?? "").replace("tick ", ""));
    expect(t).toBeGreaterThanOrEqual(stuckAt + 100); // the step that was waiting for the space runs
  }).toPass({ timeout: 15_000 });
});
