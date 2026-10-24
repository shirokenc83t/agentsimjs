import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, sendTo, step } from "./helpers.ts";

const astar = (extra: object = {}) => ({ kind: "algorithm", algorithm: "astar", ...extra });
const hpa = { kind: "algorithm", algorithm: "hpa" };
const inline = (root: unknown) => JSON.stringify({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root });

/** Starts a new run with the given inline strategy for every agent. */
async function runWithStrategy(page: Page, root: unknown) {
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-planner").selectOption("strategy");
  await panel.getByTestId("rc-strategy-preset").selectOption("inline");
  await panel.getByTestId("rc-strategy-json").fill(inline(root));
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await openWorkspace(page, "scene");
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().chunksPending)).toBe(0);
}

// ROADMAP F2b acceptance: a select picks a branch by a condition, and the branch with the values it saw is visible.
test("the query table shows which branch a select took, with the condition values, for a near and a far target", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await runWithStrategy(page, { kind: "select", branches: [{ when: "dist.m <= 12", then: astar() }], else: hpa });

  // The rover starts at (10, 10): 4 m is near, 40 m is far.
  await sendTo(page, "ugv-001", 14, 10);
  await step(page, 1);
  const rows = page.getByTestId(/^plan-query-row-/);
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page.getByTestId("plan-query-select-0")).toContainText("→ 0");
  await expect(page.getByTestId("plan-query-select-0")).toContainText("dist.m = 4");
  await expect(page.getByTestId("plan-query-search-0")).toContainText("astar");

  await sendTo(page, "ugv-001", 50, 10);
  await step(page, 1);
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();
  await expect(page.getByTestId("plan-query-select-0")).toContainText("→ else");
  // The rover has moved on since the first query, so the distance is read, not assumed: it must exceed the threshold.
  const far = (await page.getByTestId("plan-query-select-0").textContent()) ?? "";
  expect(Number(/dist\.m = ([\d.]+)/.exec(far)?.[1])).toBeGreaterThan(12);
  await expect(page.getByTestId("plan-query-search-0")).toContainText("hpa");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
});

// ROADMAP F2b acceptance: a fallback on budget_exceeded; the stages, expansions and ticks of each search are shown.
test("a fallback that runs out of budget shows both searches with their expansions, ticks and results", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await runWithStrategy(page, { kind: "fallback", stages: [astar({ stageBudget: 10 }), hpa] });
  await sendTo(page, "ugv-001", 50, 10);
  await step(page, 1);
  await page.getByTestId(/^plan-query-row-/).first().click();
  await expect(page.getByTestId("plan-query-search-0")).toContainText("astar");
  await expect(page.getByTestId("plan-query-search-0")).toContainText("budget_exceeded");
  await expect(page.getByTestId("plan-query-search-0")).toContainText("10 exp");
  await expect(page.getByTestId("plan-query-search-1")).toContainText("hpa");
  await expect(page.getByTestId("plan-query-search-1")).toContainText("found");
  await expect(page.getByTestId("plan-query-detail")).toContainText("strategy:mine@1");
});
