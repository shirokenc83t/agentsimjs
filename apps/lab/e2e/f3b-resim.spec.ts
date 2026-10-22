import { expect, test } from "@playwright/test";
import { loadDemo, openWorkspace, runCommand, step } from "./helpers.ts";

// F3b M2: "Re-simulate window…" from the palette (ADR-0035 section 3): a window of the recorded run around the cursor is executed again in a worker of its own, stored as a derived run
// linked to its parent with its verdict, and shown; the live run goes on untouched.

test("the palette re-simulates a window of the run into a derived run that matches, and the live run is not touched", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 30_000 });
  const tickBefore = await page.getByTestId("status-tick").textContent();

  await runCommand(page, "Re-simulate window…");
  const note = page.getByTestId("resim-notice");
  await expect(note).toContainText("re-simulated as run-000002", { timeout: 120_000 });
  await expect(note).toContainText("it matches");
  await expect(note).not.toContainText("DIVERGENT");
  // The live run keeps its place: it is not replaced and not stepped by the re-simulation.
  await expect(page.getByTestId("replay-segment")).toHaveCount(0);
  expect((await page.getByTestId("status-tick").textContent()) ?? "").toBe(tickBefore);

  // It is a run of its own in storage, marked with its parent.
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("run-row-run-000002")).toContainText("window");
  await expect(page.getByTestId("run-row-run-000001")).toBeVisible();
  await page.getByTestId("resim-notice-dismiss").click();
  await expect(note).toHaveCount(0);
});

test("a run that was not recorded cannot be re-simulated by window, and the reason is said", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("recording-opt-out").check();
  await page.getByTestId("rerun").click();
  await expect(page.getByTestId("run-id")).not.toHaveText("run-000001");
  await page.keyboard.press("Escape");
  await step(page, 2);
  await runCommand(page, "Re-simulate window…");
  await expect(page.getByTestId("resim-notice")).toContainText("was not recorded", { timeout: 30_000 });
  await expect(page.getByTestId("resim-notice")).toContainText("cannot be re-simulated");
});
