import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// The trace graph window (U-010 section 2) on a real run: opened from the Trace panel, layered around the record picked in the Log; a click selects (the shared record), a double
// click recentres with a breadcrumb back, Backspace goes back, the arrows move, the children are one lane in time order whose runs fold and whose long middle collapses.

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
  await page.locator('[data-testid^="event-row-"]').filter({ hasText: "start" }).first().click({ timeout: 20_000 });
  await expect(page.getByTestId("trace-tree-selected")).toBeVisible();
}

test("the trace graph: opened from the Trace panel, around the record, a click selects, a double click recentres with a way back, the arrows move, the side panel has the JSON", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 3);
  await page.getByTestId("trace-open-graph").click();
  const graph = page.getByTestId("trace-graph");
  await expect(graph).toBeVisible();
  await expect(page.getByRole("tab", { name: /\[5c\] Trace graph/ })).toBeVisible();
  // The record is in the middle with its children as a lane on the right (depth 1), linked to it by a bracket.
  const centre = page.getByTestId("tg-node-center");
  await expect(centre).toContainText("start");
  const startSeq = Number(await centre.getAttribute("data-seq"));
  await expect.poll(async () => await graph.locator('[data-testid^="tg-node-"]:not([data-testid="tg-node-center"])').count()).toBeGreaterThan(3);
  await expect(graph.getByTestId("tg-lane")).toBeVisible();
  await expect(graph.getByTestId("tg-bracket")).toHaveCount(1);
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

test("the children are a lane in time order: runs of the same kind and op fold, a long middle collapses and opens a page at a time, the lane scrolls; depth and sides change the columns", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 8);
  await page.getByTestId("trace-open-graph").click();
  const graph = page.getByTestId("trace-graph");
  await expect(graph.getByTestId("tg-node-center")).toBeVisible();
  const lane = graph.getByTestId("tg-lane");
  await expect(lane).toBeVisible({ timeout: 15_000 });
  const steps = () => lane.locator("[data-node]").count();
  // The times run down the rail in order.
  const times = await lane.locator(".tg-time").allTextContents();
  const secs = times.map((t) => Number.parseFloat(t));
  expect(secs.length).toBeGreaterThan(2);
  expect([...secs].sort((x, y) => x - y)).toEqual(secs);
  // A long middle is one row that opens twenty rows at a time (the runs of the same kind and op are folded where there are any: the unit tests have them).
  const gap = graph.getByTestId("tg-group-node");
  await expect(gap).toContainText(/^… \d+ more · /);
  const before = await steps();
  await gap.click();
  await expect.poll(steps).toBeGreaterThan(before);
  await page.getByTestId("tg-fold").uncheck();
  await expect(graph.getByTestId("tg-run-node")).toHaveCount(0);
  expect(Number(await lane.getAttribute("data-total"))).toBeGreaterThan(24);
  // The lane keeps its height and scrolls.
  expect(await lane.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByTestId("tg-fold").check();

  // Depth: grandchildren as indented steps, and a side turned off hides its column.
  const nodes = () => graph.locator("[data-node]").count();
  const one = await nodes();
  await page.getByTestId("tg-depth-2").click();
  await expect.poll(nodes).toBeGreaterThanOrEqual(one);
  await page.getByTestId("tg-side-children").click();
  await expect(lane).toHaveCount(0);
  await expect.poll(nodes).toBeLessThan(one);
  await page.getByTestId("tg-fit").click();
  await expect(page.getByTestId("tg-scaled")).toHaveAttribute("data-scale", /^\d/);
});

test("the graph is easy to find: a labelled button in the Trace, T on a selected record, the Log row's context menu, the palette, and the Trace's empty state says so", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 3);
  await expect(page.getByTestId("trace-open-graph")).toHaveText(/open graph · T/);
  const closeGraph = async () => {
    await page.getByTestId("wb-close-traceGraph").click();
    await expect(page.getByTestId("trace-graph")).toHaveCount(0);
  };
  // T on the selected record (focus on the list, as after a click on a row).
  await page.keyboard.press("t");
  await expect(page.getByTestId("trace-graph")).toBeVisible();
  await closeGraph();
  // The row's context menu.
  await page.locator('[data-testid^="event-row-"]').first().click({ button: "right" });
  await expect(page.getByTestId("log-menu")).toBeVisible();
  await page.getByTestId("log-menu-graph").click();
  await expect(page.getByTestId("trace-graph")).toBeVisible();
  await closeGraph();
  // The palette.
  await runCommand(page, "Open panel: Trace graph");
  await expect(page.getByTestId("trace-graph")).toBeVisible();
});

test("the Trace's empty state points to the graph, and the theme button says its theme", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadF2(page, "discovery");
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("trace-tree-empty")).toContainText("T opens its graph");
  await expect(page.getByTestId("theme-button")).toHaveText(/◐ (dark|light|system) ▾/);
});
