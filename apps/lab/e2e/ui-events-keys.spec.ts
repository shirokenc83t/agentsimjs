import { expect, test } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// The Events list of the Debug workspace is driven from the keyboard: Up and Down move the selection (and with it the cursor and the agent), Home and End go to the
// first and the last row read.

test("arrow keys, Home and End move the selection of the event list and the cursor with it", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await runCommand(page, "Explore selected agent (ugv-001)");
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 20_000 });
  await openWorkspace(page, "debug");
  await page.getByTestId("event-filter-agent").selectOption("ugv-001");
  await page.getByTestId("event-kind-action").click({ modifiers: ["Shift"] }); // that kind alone
  const rows = page.locator('[data-testid^="event-row-"]');
  // Both filters are applied (the list starts again at each): only the rover's actions are listed, and there are several.
  await expect.poll(async () => (await rows.count()) > 3 && (await page.locator('[data-testid^="event-row-"]:not([data-kind="action"])').count()) === 0 && (await page.locator('[data-testid^="event-row-"]:not([data-agent="ugv-001"])').count()) === 0, { timeout: 15_000 }).toBe(true);

  const list = page.getByRole("listbox", { name: "Events" });
  const selectedRow = list.locator('[role="option"][aria-selected="true"]');
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(selectedRow).toHaveCount(1);
  const first = await selectedRow.getAttribute("data-testid");
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("ArrowDown");
  await expect(selectedRow).toHaveCount(1);
  const second = await selectedRow.getAttribute("data-testid");
  expect(second).not.toBe(first);
  await page.keyboard.press("ArrowUp");
  await expect(selectedRow).toHaveAttribute("data-testid", first ?? "");
  await page.keyboard.press("End");
  await expect(selectedRow).toHaveCount(1);
  await expect(selectedRow).not.toHaveAttribute("data-testid", first ?? "");
  // The cursor is on the selected row's moment.
  const endTime = Number(((await selectedRow.textContent()) ?? "").split(" s")[0]);
  await expect(page.getByTestId("replay-time")).toContainText(`${endTime.toFixed(1)} s /`);
  await page.keyboard.press("Home");
  await expect(selectedRow).toHaveAttribute("data-testid", first ?? ""); // the first row is the one the first Down reached
  await expect(page.getByTestId("event-detail")).toContainText('"kind"');
});
