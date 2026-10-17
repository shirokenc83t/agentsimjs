import { expect, test, type Page } from "@playwright/test";
import { loadDemo } from "./helpers.ts";

async function header(page: Page) {
  await page.getByTestId("run-label").click();
  const h = {
    runId: (await page.getByTestId("run-id").textContent()) ?? "",
    scenario: (await page.getByTestId("run-scenario").textContent()) ?? "",
    runConfigHash: (await page.getByTestId("run-config-hash").textContent()) ?? "",
    mode: (await page.getByRole("dialog", { name: "Run" }).locator("dt:text-is('time mode') + dd").textContent()) ?? "",
  };
  await page.keyboard.press("Escape");
  return h;
}

// 2026-10-09: the time mode is part of the run (header, runConfigHash). While a run is loaded it is
// read-only; changing it starts a new run of the same scenario version with the run configuration's timeMode
// changed. (The worker also refuses a mid-run change: sim-host.test.ts.)
test("the time mode is read-only during a run; 're-run in realtime' starts a new run with new hashes", async ({ page }) => {
  await loadDemo(page);
  await expect(page.getByRole("combobox", { name: "Time mode" })).toHaveCount(0);
  await expect(page.getByTestId("time-mode")).toHaveText("lockstep");
  const before = await header(page);
  expect(before.mode).toBe("lockstep");

  await page.getByTestId("rerun-in-mode").click();
  await expect(page.getByTestId("time-mode")).toHaveText("realtime");
  const after = await header(page);
  expect(after.runId).not.toBe(before.runId);
  expect(after.scenario).toBe(before.scenario); // same scenario version
  expect(after.mode).toBe("realtime");
  expect(after.runConfigHash).not.toBe(before.runConfigHash);

  // Pause and step do not change results and stay available.
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await page.getByTestId("step").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 1");

  // And back: lockstep again gives the original run configuration hash (lockstep is the default, written by omission).
  await page.getByTestId("rerun-in-mode").click();
  await expect(page.getByTestId("time-mode")).toHaveText("lockstep");
  const back = await header(page);
  expect(back.runConfigHash).toBe(before.runConfigHash);
  expect(back.runId).not.toBe(after.runId);
});
