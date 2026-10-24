import { expect, test } from "@playwright/test";
import { loadF2, openPerf, step } from "./helpers.ts";

// ROADMAP F2 acceptance: 20 agents with 180-ray lidar at 10 Hz in the tick budget: the HUD shows the sensing and planning
// budget in use. The time itself is gated by the node bench (sim.sensing20x180); software GL in CI is not asserted here.
test("the HUD shows the sensing time, the rays fired per tick and the planning spending for the 20-agent run", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "agents");
  await step(page, 1);
  await openPerf(page);
  const hud = page.getByTestId("perf-hud");
  // 20 agents × 180 lidar rays = 3,600 per tick (the proximity sensors add 8 rays each).
  await expect(hud.getByTestId("hud-rays")).toHaveText("3760 (3600 lidar)");
  await expect(hud.getByTestId("hud-sensing")).toContainText(/\d+(\.\d+)? ms · p95 \d+(\.\d+)? ms/);
  await expect(hud.getByTestId("hud-planning")).toContainText("exp/tick");
});
