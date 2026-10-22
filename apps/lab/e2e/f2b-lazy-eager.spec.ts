import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, sendTo, step } from "./helpers.ts";

const astar = { kind: "algorithm", algorithm: "astar" };
const hpa = { kind: "algorithm", algorithm: "hpa" };
const refine = (mode: "lazy" | "eager") => JSON.stringify({ schemaVersion: 0, id: `r-${mode}`, version: 1, origin: "human", root: { kind: "refine", mode, coarse: hpa, local: astar } });

/** A new run with a refine strategy in `mode` on `unknown` maps and a slow planner (100 expansions per tick), so planning takes ticks. */
async function runRefine(page: Page, mode: "lazy" | "eager") {
  await openWorkspace(page, "author");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-planner").selectOption("strategy");
  await panel.getByTestId("rc-strategy-preset").selectOption("inline");
  await panel.getByTestId("rc-strategy-json").fill(refine(mode));
  await panel.getByTestId("rc-per-tick").fill("100");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await openWorkspace(page, "scene");
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().chunksPending)).toBe(0);
}

const stages = (page: Page) => page.evaluate(() => window.__agentsim?.scene?.overlays().stages);

// ROADMAP F2b acceptance: lazy starts earlier than eager (both deterministic); and the stages overlay shows what the planner did.
test("a lazy refine hands out its first leg earlier than the eager one finishes its plan, and the stages are drawn", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);

  const queryNumbers = async () => {
    await page.getByTestId("explorer-row-ugv-001").click();
    await sendTo(page, "ugv-001", 60, 58);
    await step(page, 2);
    const row = page.getByTestId(/^plan-query-row-/).first();
    await expect(row).toBeVisible();
    await row.click();
    return row;
  };

  await runRefine(page, "eager");
  const eagerRow = await queryNumbers();
  const eagerText = (await eagerRow.textContent()) ?? "";
  const eagerDone = Number(/tick \d+→(\d+)/.exec(eagerText)?.[1]);
  expect(eagerDone, eagerText).toBeGreaterThan(1);
  await expect(page.getByTestId("plan-query-detail")).toContainText("coarse");

  await runRefine(page, "lazy");
  await queryNumbers();
  await expect(page.getByTestId("plan-query-leg-0")).toContainText("leg 1/");
  const leg0 = (await page.getByTestId("plan-query-leg-0").textContent()) ?? "";
  const lazyFirst = Number(/ready at tick (\d+)/.exec(leg0)?.[1]);
  expect(lazyFirst, leg0).toBeGreaterThan(0);
  expect(lazyFirst).toBeLessThan(eagerDone);

  // The stages overlay follows the selected query: the coarse path dashed, the legs solid, a joint between them.
  await page.getByTestId("overlay-stages").click();
  await expect(page.getByTestId("stages-legend")).toContainText("coarse path of a refine");
  await expect.poll(async () => (await stages(page))?.legs ?? 0).toBeGreaterThan(0);
  const drawn = await stages(page);
  expect(drawn?.coarseDashes).toBeGreaterThan(0);
  expect(drawn?.legSegments).toBeGreaterThan(0);
  expect(drawn?.joints).toBe(Math.max(0, (drawn?.legs ?? 0) - 1));

  // Switching it off clears it.
  await page.getByTestId("overlay-stages").click();
  await expect.poll(async () => (await stages(page))?.legs ?? -1).toBe(0);
});

test("the stages overlay follows the query selected in the Inspector's table", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);
  await runRefine(page, "eager");
  await page.getByTestId("explorer-row-ugv-001").click();
  await sendTo(page, "ugv-001", 60, 58);
  await step(page, 2);
  await sendTo(page, "ugv-001", 35, 35); // on screen clear of the scene overlay
  await step(page, 2);
  const rows = page.getByTestId(/^plan-query-row-/);
  await expect(rows).toHaveCount(2);
  await page.getByTestId("overlay-stages").click();
  await rows.nth(0).click();
  await expect.poll(async () => (await stages(page))?.legs ?? 0).toBeGreaterThan(0);
  const first = await stages(page);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => JSON.stringify(await stages(page))).not.toBe(JSON.stringify(first));
});
