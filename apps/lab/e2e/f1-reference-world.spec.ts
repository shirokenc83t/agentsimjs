import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { loadReference, openPanelTab, openWorkspace, referenceSettled, sendTo, step } from "./helpers.ts";

/** Golden world hash of buildReferenceWorld(), shared with the Node test of the preset. */
const GOLDEN = JSON.parse(readFileSync("packages/scenarios/src/presets/f1-reference-world.golden.json", "utf8")) as { worldHash: string };

// F1 f1: the world built from the UI preset (in the sim worker) is the world the benchmarks build.
test("the 1 km² reference world loaded from the UI is the benchmarks' world (same world hash)", async ({ page }) => {
  test.setTimeout(180_000);
  await loadReference(page);
  await expect(page.getByTestId("world-hash")).toHaveText(GOLDEN.worldHash);
  await page.keyboard.press("Escape");
  await referenceSettled(page);
  expect(await page.evaluate(() => window.__agentsim?.scene?.stats().pages)).toBe(1);
});

// ROADMAP F1 acceptance: HPA* on a 1 km² world at 0.5 m plans a cross-map path within the configured budget.
test("HPA* set from the run configuration plans a cross-map path on the 1 km² world within its budget", async ({ page }) => {
  test.setTimeout(240_000);
  await loadReference(page);
  const firstRun = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");

  await openWorkspace(page, "author");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-algorithm").selectOption("hpa");
  await expect(panel.getByTestId("rc-effective-ugv-001")).toContainText("hpa");
  await panel.getByTestId("rc-run").click();
  await openWorkspace(page, "scene");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(firstRun, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await referenceSettled(page);

  // (950, 500): (950, 950) projects under the Performance HUD in the default camera framing.
  await sendTo(page, "ugv-001", 950, 500);
  // The abstract graph was prepared before tick 0 (F2 M1a); the generous timeout is for slow CI runners.
  await step(page, 1, 60_000);
  await expect(page.getByTestId("inspector-plan")).toContainText("hpa", { timeout: 30_000 });
  const expansions = Number((await page.getByTestId("inspector-plan-expansions").textContent())?.replace(/\D/g, ""));
  const budget = Number((await page.getByTestId("inspector-config").textContent())?.match(/totalBudget\s*(\d+)/)?.[1]);
  expect(expansions).toBeGreaterThan(0);
  expect(budget).toBeGreaterThan(0);
  expect(expansions).toBeLessThanOrEqual(budget);
  // The path crosses the map (start near the south-west corner, goal near the east edge, about 1,070 m away).
  const text = (await page.getByTestId("inspector-plan-waypoints").textContent()) ?? "";
  const wp = [...text.matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  expect(wp[0]?.[0]).toBeLessThan(10);
  expect(Number((await page.getByTestId("inspector-plan-path").textContent())?.match(/^([\d.]+) m/)?.[1])).toBeGreaterThan(1000);
});
