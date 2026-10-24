import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// The trace graph window (U-010 section 2) on a real run: opened from the Trace panel, layered around the record picked in the Log; a click selects (the shared record), a double
// click recentres with a breadcrumb back, Backspace goes back, the arrows move, a column of many children is a group node, and grouping by kind · op collapses a column.

const AGENT = "ugv-001";

async function open(page: Page, hundreds: number): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, hundreds);
  await expect(page.getByTestId("status-recording-saved")).toHaveText(`saved to tick ${hundreds * 100}`, { timeout: 30_000 });
  await openWorkspace(page, "debug");
  await page.getByTestId("log-filter").fill(`kind:action agent:${AGENT} text:start`);
  await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.getByTestId("event-scroller").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.locator('[data-testid^="event-row-"]').filter({ hasText: "start" }).first().click();
  await expect(page.getByTestId("trace-tree-selected")).toBeVisible();
}

test("the trace graph: opened from the Trace panel, around the record, a click selects, a double click recentres with a way back, the arrows move, the side panel has the JSON", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 3);
  await page.getByTestId("trace-open-graph").click();
  const graph = page.getByTestId("trace-graph");
  await expect(graph).toBeVisible();
  await expect(page.getByRole("tab", { name: /\[5c\] Trace graph/ })).toBeVisible();
  // The record is in the middle with its children on the right (depth 1), the parent edges solid.
  const centre = page.getByTestId("tg-node-center");
  await expect(centre).toContainText("start");
  const startSeq = Number(await centre.getAttribute("data-seq"));
  await expect.poll(async () => await graph.locator('[data-testid^="tg-node-"]:not([data-testid="tg-node-center"])').count()).toBeGreaterThan(3);
  expect(await graph.getByTestId("tg-edge-parent").count()).toBeGreaterThan(3);
  await expect(page.getByTestId("tg-json")).toContainText(`"seq": ${startSeq}`);

  // A click selects the record: the shared record is that one (the Trace panel and the Log follow); the graph stays around the same centre.
  const child = graph.locator('[data-testid^="tg-node-"]:not([data-testid="tg-node-center"])').first();
  const childSeq = Number(await child.getAttribute("data-seq"));
  await child.click();
  await expect(page.getByTestId("trace-tree-selected")).toHaveAttribute("data-seq", String(childSeq));
  await expect(page.getByTestId("tg-center")).toHaveText(`#${startSeq}`);
  await expect(page.getByTestId("tg-json")).toContainText(`"seq": ${childSeq}`);

  // A double click puts the graph around it, with the way back: the breadcrumb, and Backspace.
  await child.dblclick();
  await expect(page.getByTestId("tg-center")).toHaveText(`#${childSeq}`);
  await expect(page.getByTestId(`tg-crumb-${startSeq}`)).toBeVisible();
  await expect(page.getByTestId("tg-node-center")).toHaveAttribute("data-seq", String(childSeq));
  await page.getByTestId("tg-node-center").focus();
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("tg-center")).toHaveText(`#${startSeq}`);
  await expect(page.getByTestId(`tg-crumb-${startSeq}`)).toHaveCount(0);

  // The arrows move between nodes: right from the record goes to a node of the next column; Enter recentres on it.
  await page.getByTestId("tg-node-center").focus();
  await page.keyboard.press("ArrowRight");
  const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-seq") ?? "");
  expect(Number(focused)).toBeGreaterThan(startSeq);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tg-center")).toHaveText(`#${focused}`);
});

test("a column of many children shows the first few and a dashed group node that a click expands; grouping by kind · op collapses it; depth and sides change the columns", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 8);
  await page.getByTestId("trace-open-graph").click();
  const graph = page.getByTestId("trace-graph");
  await expect(graph.getByTestId("tg-node-center")).toBeVisible();
  const kids = () => graph.locator('[data-testid^="tg-node-"]:not([data-testid="tg-node-center"])').count();
  await expect(page.getByTestId("tg-group-node")).toBeVisible({ timeout: 15_000 }); // an exploring rover's start has more than 12 children by now
  const shown = await kids();
  expect(shown).toBeLessThanOrEqual(6 + 1);
  await expect(page.getByTestId("tg-group-node")).toContainText(/^\+ \d+ more · /);
  await page.getByTestId("tg-group-node").click();
  await expect.poll(kids).toBeGreaterThan(shown);

  await page.getByTestId("tg-group").check();
  await expect(page.getByTestId("tg-group-node").first()).toContainText(/×\d+/);
  await page.getByTestId("tg-group").uncheck();

  // Depth: a second column of children, and a side turned off hides its column.
  const nodes = () => graph.locator("[data-node]").count();
  const one = await nodes();
  await page.getByTestId("tg-depth-2").click();
  await expect.poll(nodes).toBeGreaterThanOrEqual(one);
  await page.getByTestId("tg-side-children").click();
  await expect.poll(nodes).toBeLessThan(one);
  await page.getByTestId("tg-fit").click();
  await expect(page.getByTestId("tg-scaled")).toHaveAttribute("data-scale", /^\d/);
});
