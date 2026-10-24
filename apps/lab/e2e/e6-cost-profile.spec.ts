import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, sendTo, step } from "./helpers.ts";

/** The demo's marsh (f1-demo.ts): x ∈ [14, 22), y ∈ [0, 16), terrain cost 200. */
const inMarsh = (x: number, y: number) => x >= 14 && x < 22 && y >= 0 && y < 16;

/** True if the polyline passes through the marsh (sampled every ~5 cm). */
function crossesMarsh(wp: [number, number][]): boolean {
  for (let k = 1; k < wp.length; k++) {
    const [ax, ay] = wp[k - 1] ?? [0, 0];
    const [bx, by] = wp[k] ?? [0, 0];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
    for (let t = 0; t <= n; t++) if (inMarsh(ax + ((bx - ax) * t) / n, ay + ((by - ay) * t) / n)) return true;
  }
  return false;
}

/** Sends the rover east of the marsh and reads the waypoints of its plan from the Inspector. */
async function planAcrossMarsh(page: Page): Promise<[number, number][]> {
  await sendTo(page, "ugv-001", 26, 8);
  await step(page, 1);
  const text = (await page.getByTestId("inspector-plan-waypoints").textContent()) ?? "";
  const wp = [...text.matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  expect(wp.length, text).toBeGreaterThanOrEqual(2);
  return wp;
}

// ROADMAP F1 acceptance: changing the cost profile changes the path, demonstrated from the UI.
test("a terrain-weighted cost profile set in the run configuration moves the rover's path around the marsh", async ({ page }) => {
  test.setTimeout(90_000);
  await loadDemo(page);

  const direct = await planAcrossMarsh(page);
  expect(crossesMarsh(direct), JSON.stringify(direct)).toBe(true);
  const firstRun = (await page.getByTestId("run-label").textContent()) ?? "";

  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await expect(panel.getByTestId("rc-run-config-hash")).toContainText("(= current run)");
  await panel.getByTestId("rc-planning-scope").selectOption("byAgent.rover");
  await panel.getByTestId("rc-override-profile").check();
  await panel.getByTestId("rc-profile-weight-terrain").fill("1");
  await expect(panel.getByTestId("rc-profile-ok")).toBeVisible();
  await expect(panel.getByTestId("rc-effective-ugv-001")).toContainText("distance 1, terrain 1");
  await expect(panel.getByTestId("rc-run-config-hash")).not.toContainText("(= current run)");
  const expectedHash = ((await panel.getByTestId("rc-run-config-hash").textContent()) ?? "").split(" ")[0] ?? "";
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("run-label")).not.toHaveText(firstRun);
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");

  // The new run's header carries the edited configuration.
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-config-hash")).toHaveText(expectedHash);
  await page.keyboard.press("Escape");

  await openWorkspace(page, "scene");
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().chunksPending)).toBe(0);
  const detour = await planAcrossMarsh(page);
  expect(crossesMarsh(detour), JSON.stringify(detour)).toBe(false);
  expect(detour.length).toBeGreaterThan(direct.length);
  await expect(page.getByTestId("inspector-config")).toContainText("byAgent");
});

test("invalid run configurations show their stable codes and cannot be run", async ({ page }) => {
  await loadDemo(page);
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-per-tick").fill("0");
  await expect(panel.getByTestId("rc-error")).toContainText("budget_out_of_range");
  await expect(panel.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "true");
  await panel.getByTestId("rc-per-tick").fill("");
  await panel.getByTestId("rc-override-profile").check();
  await panel.getByTestId("rc-profile-add-constraint").click();
  await panel.getByTestId("rc-profile-constraint-0").fill("globalThis.alert(1)");
  await expect(panel.getByTestId("rc-profile-constraint-0-issue")).toContainText("constraint_invalid");
  await expect(panel.getByTestId("rc-error")).toContainText("constraint_invalid");
});
