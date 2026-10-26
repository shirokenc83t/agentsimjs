import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step, waitForStorageReady } from "./helpers.ts";

// F3b M3 (ADR-0035 section 7): the multi-log inspector of the Debug workspace: a source tree, up to four panes (log, table, series), one shared record and cursor, a Live / Replay
// switch with the same panes and filters, and the panes kept per user. For a recorded run, the live and the replay panes show the same records.

const AGENT = "ugv-001";

// Tall enough for three panes in a grid (each keeps its minimum size; below that they are tabs, see f3b-m3-fixes).
test.use({ viewport: { width: 1440, height: 1000 } });

async function recorded(page: Page): Promise<void> {
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 20_000 });
}

async function openInspector(page: Page): Promise<void> {
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("log-inspector")).toBeHidden(); // a tab behind the Inspector: one command brings it forward
  await runCommand(page, "Open panel: Logs");
  await expect(page.getByTestId("log-inspector")).toBeVisible();
}

const count = async (page: Page, pane: string) => Number(await page.getByTestId(`pane-${pane}`).locator('[data-testid="pane-log"], [data-testid="pane-table"]').first().getAttribute("data-count"));

test("the live and the replay panes show the same records of a recorded run; a pick in any pane moves the shared cursor; a series pane shows a metric", async ({ page }) => {
  test.setTimeout(240_000);
  await recorded(page);
  await openInspector(page);

  // The panes it starts with: a log of actions and flags, and the tick cost as a series.
  await expect(page.getByTestId("pane-p1")).toHaveAttribute("data-view", "log");
  await expect(page.getByTestId("pane-p2")).toHaveAttribute("data-view", "series");
  await expect(page.getByTestId("inspector-panes")).toHaveAttribute("data-mode", "live");
  await expect.poll(() => count(page, "p1"), { timeout: 15_000 }).toBeGreaterThan(3);
  const live = await count(page, "p1");
  await expect(page.getByTestId("pane-p2").getByTestId("pane-series")).toHaveAttribute("data-lines", /^[1-9]/, { timeout: 15_000 });

  // Replay: the same panes, the same filters, reading what is stored: the same records.
  await page.getByTestId("inspector-replay").check();
  await expect(page.getByTestId("inspector-panes")).toHaveAttribute("data-mode", "replay");
  await expect.poll(() => count(page, "p1"), { timeout: 15_000 }).toBe(live);
  await expect(page.getByTestId("pane-p1").getByTestId("pane-list")).toHaveAttribute("data-count", String(live));

  // A table pane of the observer's samples next to them; a pick in it moves the shared cursor, and the other panes follow the record.
  await page.getByTestId("inspector-add").selectOption("table");
  const table = page.locator('[data-view="table"]').first();
  await table.getByTestId("pane-table").waitFor();
  await table.locator('[role="row"][data-seq]').first().waitFor({ timeout: 15_000 });
  const row = table.locator('[role="row"][data-seq]').nth(2);
  const seq = Number(await row.getAttribute("data-seq"));
  const t = Number((await row.locator('[role="cell"]').nth(1).textContent()) ?? "0");
  await row.click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("replay-time")).toContainText(`${t.toFixed(1)} s /`);
  await expect(table.locator(`[data-seq="${seq}"][aria-selected="true"]`)).toBeVisible();

  // A pick in the log pane moves the same cursor.
  const logRow = page.getByTestId("pane-p1").locator('[role="option"]').nth(3);
  const logT = Number(((await logRow.textContent()) ?? "").split(" s")[0]);
  await logRow.click();
  await expect(page.getByTestId("replay-time")).toContainText(`${logT.toFixed(1)} s /`);

  // The metrics of an agent as a series, from the source tree; the cursor is drawn on it, and a click on it sets the cursor.
  await page.getByTestId(`source-${AGENT}-metrics`).click();
  const series = page.locator('[data-view="series"]').last();
  await expect(series.getByTestId("pane-series")).toHaveAttribute("data-lines", /^[1-9]/, { timeout: 15_000 });
  await expect(series.getByTestId("series-cursor")).toHaveCount(1); // a vertical line has no width: attached, not "visible"
  const chart = series.getByTestId("series-chart");
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error("no chart");
  await chart.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } }); // scrolls the pane into view (the panel is small: its panes scroll)
  const at = () => page.getByTestId("replay-time").textContent().then((x) => Number((x ?? "").split(" s")[0]));
  await expect.poll(at, { timeout: 10_000 }).toBeGreaterThan(5);
  expect(await at()).toBeLessThan(25);
});

test("the tree adds panes up to the limit, a view can change, a filter that does not fit is said, the future views are listed as such, and the panes are kept per user", async ({ page }) => {
  test.setTimeout(240_000);
  await recorded(page);
  await openInspector(page);
  await page.getByTestId("inspector-replay").check();

  // The source tree: agents with their components, and the world.
  await expect(page.getByTestId("source-tree")).toContainText(AGENT);
  await expect(page.getByTestId(`source-${AGENT}-planner`)).toBeVisible();
  await expect(page.getByTestId("source-world-sim")).toBeVisible();
  await expect(page.getByTestId("source-world-storage")).toBeVisible();
  await page.getByTestId(`source-${AGENT}-actions`).click();
  await expect(page.locator('[data-testid^="pane-n"]').last()).toHaveAttribute("data-view", "log");
  await expect(page.locator('[data-testid^="pane-filter-n"]').last()).toHaveValue(`source:${AGENT}/actions`);
  // At most four: a fifth takes the oldest's place.
  await page.getByTestId("source-world-sim").click();
  await page.getByTestId("source-world-storage").click();
  await expect(page.locator('[data-testid^="pane-"][data-view]')).toHaveCount(4);
  await expect(page.getByTestId("pane-p1")).toHaveCount(0);

  // A view changes: a filter that fits the new view stays, one that does not becomes the view's own.
  const pane = page.locator('[data-testid^="pane-n"][data-view="log"]').first();
  const id = ((await pane.getAttribute("data-testid")) ?? "").replace("pane-", "");
  await page.getByTestId(`pane-view-${id}`).selectOption("series");
  await expect(page.getByTestId(`pane-filter-${id}`)).toHaveValue("metric:agent.soc");
  await page.getByTestId(`pane-filter-${id}`).fill("kind:action");
  await expect(page.getByTestId(`pane-${id}`).getByRole("alert")).toContainText("a series needs a metric: filter");
  await page.getByTestId(`pane-filter-${id}`).fill("metric:sim.tickMs");
  await expect(page.getByTestId(`pane-${id}`).getByRole("alert")).toHaveCount(0);

  // The views that are not there yet are listed, disabled, with their phase.
  const options = await page.getByTestId("inspector-add").locator("option").allTextContents();
  expect(options.join("|")).toContain("mind I/O — F4");
  expect(options.join("|")).toContain("ladder — F8");
  await expect(page.getByTestId("inspector-add").locator("option", { hasText: "mind I/O" })).toBeDisabled();

  // Kept per user: after a reload the same panes are there.
  const filters = await page.locator('[data-testid^="pane-filter-"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  await page.waitForTimeout(600); // the layout is written a moment after the last change
  await page.reload();
  await waitForStorageReady(page);
  await openWorkspace(page, "debug");
  await runCommand(page, "Open panel: Logs");
  await expect(page.getByTestId("log-inspector")).toBeVisible();
  await expect.poll(async () => page.locator('[data-testid^="pane-filter-"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(filters);
  // and the reset puts the first two back
  await page.getByTestId("inspector-reset").click();
  await expect(page.locator('[data-testid^="pane-"][data-view]')).toHaveCount(2);
});
