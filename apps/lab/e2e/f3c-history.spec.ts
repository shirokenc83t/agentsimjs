import { expect, test, type Page } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace, runCommand, step } from "./helpers.ts";

// The agent action history (T-102, ADR-0043): opened for the selected agent from the Explorer (H) and from Analysis, one row per level on one time axis, a node opens into the
// records it came from by their parent links with a dashed bracket and the deepest row stretched, Backspace folds, the arrows move and select (the shared record), the side panel
// has the node's fields and its actions.

const AGENT = "ugv-001";

async function recorded(page: Page, hundreds: number): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, hundreds);
  await expect(page.getByTestId("status-recording-saved")).toHaveText(`saved to tick ${hundreds * 100}`, { timeout: 30_000 });
}

test("the history opens from the Explorer with H: commands and actions on one axis, an action opens into its steps with a bracket, the deepest row is stretched, Backspace folds", async ({ page }) => {
  test.setTimeout(240_000);
  await recorded(page, 3);
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await page.keyboard.press("h");
  const history = page.getByTestId("agent-history");
  await expect(history).toBeVisible();
  await expect(history).toHaveAttribute("data-agent", AGENT);
  await expect(page.getByRole("tab", { name: `${AGENT} history` })).toBeVisible();
  await expect(page.getByTestId("agent-history-title")).toContainText(AGENT);

  // Two rows: the command (◆) and the actions as bars; the explore action is a bar with its outcome glyph.
  await expect(page.getByTestId("ah-row-1")).toBeVisible();
  await expect(page.getByTestId("ah-row-2")).toBeVisible();
  await expect(page.getByTestId("ah-row-1").locator('[data-kind="command"]').first()).toBeVisible({ timeout: 20_000 });
  const explore = page.getByTestId("ah-row-2").locator('[data-kind="action"]', { hasText: "explore" }).first();
  await expect(explore).toBeVisible();
  // Positions come from time only: the same x twice.
  const x1 = await explore.getAttribute("data-x");
  await page.getByTestId("ah-collapse").click({ force: true });
  expect(await explore.getAttribute("data-x")).toBe(x1);

  // A click selects (the shared record: the side panel and the Trace follow), a double click opens it into its children below with a bracket and the stretched row.
  await explore.click();
  await expect(page.getByTestId("ah-sel-label")).toContainText("explore");
  await expect(page.getByTestId("ah-fields")).toContainText("action · start");
  await expect(page.getByTestId("ah-fields")).toContainText("none recorded");
  await explore.dblclick();
  await expect(page.getByTestId("ah-row-3")).toBeVisible();
  await expect(page.getByTestId("ah-bracket-3")).toBeVisible();
  await expect(page.getByTestId("ah-stretched")).toBeVisible();
  await expect(page.getByTestId("agent-history-crumbs")).toContainText(`${AGENT} › explore`);
  await expect.poll(async () => await page.getByTestId("ah-row-3").locator("[data-node]").count(), { timeout: 15_000 }).toBeGreaterThan(1);

  // The arrows move along the row and select; Escape clears the selection; Backspace folds the opened node.
  await page.getByTestId("agent-history").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("ah-fields")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ah-fields")).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("ah-row-3")).toHaveCount(0);
  await expect(page.getByTestId("ah-stretched")).toHaveCount(0);
});

test("history and audit is one tab in Analysis: the audit table with reasons and causes, the brush of the compact history filters it, a click on a chart point says where the value comes from", async ({ page }) => {
  test.setTimeout(240_000);
  await recorded(page, 3);
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await openWorkspace(page, "analysis");
  await expect(page.getByTestId("analysis")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await page.keyboard.press("h");
  const audit = page.getByTestId("agent-audit");
  await expect(audit).toBeVisible();
  await expect(page.getByRole("tab", { name: `${AGENT} · history and audit` })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Analysis/ })).toBeVisible();
  await expect(page.getByTestId("aa-findings")).toContainText(`${AGENT} ran`, { timeout: 20_000 });

  // The audit: one row per action with its outcome and reason; the compact history is on top with a way to the full one.
  await expect(page.getByTestId("agent-history-compact")).toBeVisible();
  await expect(page.getByTestId("ah-open-full")).toContainText("open full history (H)");
  const rows = page.getByTestId("aa-table").locator('tr[data-kind="action"]');
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(rows.first()).toContainText(/✓|✕|▲|▶/);
  await expect(page.getByTestId("aa-count")).toContainText("whole run");
  // A row click moves the shared record and the cursor.
  const explore = page.getByTestId("aa-table").locator('tr[data-kind="action"]', { hasText: "explore" }).first();
  await explore.click();
  await expect(explore).toHaveClass(/sel/);
  const seq = await explore.getAttribute("data-seq");
  expect(Number(seq)).toBeGreaterThanOrEqual(0);

  // The brush on the compact history filters the audit: a stretch that holds no explore row leaves it out.
  const strip = page.getByTestId("ah-overview");
  const box = await strip.boundingBox();
  if (box === null) throw new Error("no overview strip");
  const before = await page.getByTestId("aa-table").locator("tbody tr").count();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.02, box.y + box.height / 2);
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.up();
  await expect(page.getByTestId("ah-brush")).toBeVisible();
  await expect(page.getByTestId("aa-count")).not.toContainText("whole run");
  expect(await page.getByTestId("aa-table").locator("tbody tr").count()).toBeLessThanOrEqual(before);
  await page.getByTestId("ah-reset-view").click();
  await expect(page.getByTestId("aa-count")).toContainText("whole run");

  // Provenance: a click on a point of a chart marks it and the panel says where the value comes from; Esc clears it.
  await expect(page.getByTestId("aa-prov-empty")).toBeVisible();
  const chart = audit.locator('[data-testid^="series-"] svg').first();
  await expect(chart).toBeVisible({ timeout: 20_000 });
  const spot = await chart.evaluate((svg) => {
    const line = svg.querySelector("polyline.line");
    const first = (line?.getAttribute("points") ?? "").split(" ")[1] ?? "";
    const [x, y] = first.split(",").map(Number);
    const r = svg.getBoundingClientRect();
    return { x: r.left + (x ?? 0), y: r.top + (y ?? 0) };
  });
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId("aa-prov-lead")).toBeVisible();
  await expect(page.getByTestId("aa-prov-lead")).toContainText(/sample of agent\.(soc|speedMps) at tick|compute record/);
  await expect(page.getByTestId("aa-prov-chain").locator("li").first()).toBeVisible();
  await expect(page.locator('[data-testid^="series-mark-"]')).toHaveCount(1);
  await audit.press("Escape");
  await expect(page.getByTestId("aa-prov-empty")).toBeVisible();
});

test("a mission's chain is three levels in the history: a decision opens into the action it started, which opens into its own steps", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadF2(page, "discovery");
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await panel.getByTestId("ms-agent").selectOption("scout");
  for (const a of ["takeoff", "goTo"]) await page.getByTestId("ms-add").selectOption(a);
  await panel.getByTestId("ms-arg-1-xM").fill("50");
  await panel.getByTestId("ms-arg-1-yM").fill("20");
  await expect(panel.getByTestId("ms-valid")).toContainText("✓ valid · 2 steps");
  await page.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await openWorkspace(page, "scene");
  await page.getByTestId("explorer-row-uav-001").click();
  const mission = page.getByTestId("inspector-mission");
  for (let k = 0; k < 80 && (await mission.getAttribute("data-status")) !== "done"; k++) await step(page, 1);
  await expect(mission).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("status-recording-saved")).toContainText("saved to tick", { timeout: 30_000 });

  await page.keyboard.press("h");
  await expect(page.getByTestId("agent-history")).toHaveAttribute("data-agent", "uav-001");
  // Level 1: the mission's decisions are on the first row (◇); level 2: the decision opens into the action it caused; level 3: that action into its own records.
  const decision = page.getByTestId("ah-row-1").locator('[data-kind="decision"]').first();
  await expect(decision).toBeVisible({ timeout: 20_000 });
  await expect(decision).toContainText("decision · step 1 of 2");
  await decision.dblclick();
  const started = page.getByTestId("ah-row-3").locator('[data-kind="record"]').first();
  await expect(started).toContainText("takeoff", { timeout: 15_000 });
  await started.dblclick();
  await expect(page.getByTestId("ah-row-4")).toBeVisible();
  await expect.poll(async () => await page.getByTestId("ah-row-4").locator("[data-node]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("agent-history-crumbs")).toContainText("decision · step 1 of 2 · takeoff › takeoff");
});
