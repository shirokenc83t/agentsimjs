import { expect, test } from "@playwright/test";
import { loadF2, sendTo, step, stepUntilEnded } from "./helpers.ts";

interface PlanRec {
  readonly kind: string;
  readonly agentId?: string;
  readonly payload: { op?: string; status?: string; waypoints?: [number, number][] };
}

/** Where a path crosses the F1 wall line x = 30.5 m (the wall spans y < 50 m), or undefined if it does not. */
const crossing = (wp: [number, number][]): number | undefined => {
  for (let k = 1; k < wp.length; k++) {
    const [x0, y0] = wp[k - 1] as [number, number];
    const [x1, y1] = wp[k] as [number, number];
    if ((x0 < 30.5) !== (x1 < 30.5)) return y0 + ((y1 - y0) * (30.5 - x0)) / (x1 - x0);
  }
  return undefined;
};

// ROADMAP F2 acceptance: replanning on discovery reaches a goal behind an initially unknown wall.
test("send the rover across the hidden F1 wall: the plan changes when the lidar finds it, and the goal is reached", async ({ page }) => {
  test.setTimeout(180_000);
  await loadF2(page, "discovery");
  await page.getByTestId("explorer-row-ugv-001").click();
  await page.getByTestId("overlay-rays").click();
  await page.getByTestId("overlay-frontiers").click();

  await sendTo(page, "ugv-001", 50, 10);
  await step(page, 1);
  // The rays of the lidar are drawn (decimated), and so are the agent's regions and frontier groups.
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.overlays().rays)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__agentsim?.scene?.overlays().rays)).toBeLessThanOrEqual(64);
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.overlays().regions)).toBeGreaterThan(0);

  await stepUntilEnded(page, 30);
  await expect(page.getByTestId("inspector-action-label")).toContainText("goTo · succeeded");

  // The first plan was made on unknown space: it crosses the wall. The final plan goes around its north end.
  const plans = await page.evaluate(() =>
    (window.__agentsim?.records?.() ?? []).filter((r) => {
      const x = r as PlanRec;
      return x.kind === "compute" && x.agentId === "ugv-001" && x.payload.op === "plan" && x.payload.status === "found";
    }) as PlanRec[],
  );
  expect(plans.length).toBeGreaterThanOrEqual(2);
  const first = crossing(plans[0]?.payload.waypoints ?? []);
  const last = crossing(plans.at(-1)?.payload.waypoints ?? []);
  expect(first, "the first plan crosses the wall line").toBeDefined();
  expect(first as number, "…through the wall (y < 50 m)").toBeLessThan(50);
  expect(last, "the final plan crosses the wall line").toBeDefined();
  expect(last as number, "…around its north end (y > 50 m)").toBeGreaterThan(50);
  // The path planned on the wall's discovery is drawn.
  expect(await page.evaluate(() => window.__agentsim?.scene?.paths("ugv-001").planned)).toBeGreaterThan(1);
});
