import { expect, test, type Page } from "@playwright/test";
import { openPanelTab, openWorkspace, referenceSettled, sendTo, waitForStorageReady } from "./helpers.ts";

async function runId(page: Page): Promise<string> {
  await page.getByTestId("run-label").click();
  const id = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  return id;
}

/** Realtime degradations shown in the status line (the element exists only once there is one). */
async function degradations(page: Page): Promise<number> {
  const el = page.getByTestId("status-degradations");
  if ((await el.count()) === 0) return 0;
  return Number((await el.textContent())?.match(/\d+/)?.[0] ?? "0");
}

// F2 M1a (ADR-0024 "at scenario load"): in F1 the first HPA* query built the abstract graph inside its tick, which
// a realtime run recorded as a tick overrun. Now the graphs are prepared before tick 0, with visible progress.
test("HPA* graphs are prepared before tick 0: progress in the status line, time in the run popover, no overrun on the first realtime query", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-reference").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-reference-1km v\d+$/, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  const first = await runId(page);

  // HPA* from the run configuration: the new run prepares its abstract graph (about 1.7 s locally).
  await openWorkspace(page, "author");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-algorithm").selectOption("hpa");
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-preparing")).toContainText(/preparing planning graphs \d+\/\d+/, { timeout: 30_000 });
  await expect(page.getByTestId("status-preparing")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => runId(page), { timeout: 60_000 }).not.toBe(first);
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("planning-prepare")).toContainText(/HPA\* graphs? · \d+ ms/);
  await page.keyboard.press("Escape");

  // The same run configuration in realtime (a new run, prepared again before tick 0).
  await openWorkspace(page, "scene");
  await page.getByTestId("rerun-in-mode").click();
  await expect(page.getByTestId("time-mode")).toHaveText("realtime", { timeout: 60_000 });
  await expect(page.getByTestId("status-preparing")).toHaveCount(0, { timeout: 60_000 });
  await referenceSettled(page);

  await page.getByTestId("play").click();
  await expect.poll(async () => Number((await page.getByTestId("status-tick").textContent())?.replace(/\D/g, "")), { timeout: 30_000 }).toBeGreaterThan(10);
  const before = await degradations(page);
  // (950, 500): (950, 950) projects under the Performance HUD in the default camera framing.
  await sendTo(page, "ugv-001", 950, 500);
  await expect(page.getByTestId("inspector-plan")).toContainText("hpa", { timeout: 60_000 });
  const tickAfterPlan = Number((await page.getByTestId("status-tick").textContent())?.replace(/\D/g, ""));
  await expect.poll(async () => Number((await page.getByTestId("status-tick").textContent())?.replace(/\D/g, "")), { timeout: 30_000 }).toBeGreaterThan(tickAfterPlan + 10);
  // No tick overrun from the first cross-map HPA* query: the graph was already built.
  expect(await degradations(page)).toBe(before);
  await page.getByTestId("pause").click();
});
