import { expect, test } from "@playwright/test";
import { loadDemo, loadF2, openWorkspace, sendTo, stepUntilEnded } from "./helpers.ts";

// F3b: the Scene workspace (ADR-0042, UI-SPEC section 4): controls in a toolbar row off the canvas, short labels and 24 identities, one-line Explorer rows, the
// floating Overview and Legend windows, and attention: a failed agent has a badge and a ring on the map, a row in the Explorer's attention group and a tile in the player.

test("the controls are a toolbar row above the map, the labels are short, the identities are 24 and the Explorer rows are one line", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "agents");
  const toolbar = await page.getByTestId("scene-toolbar").boundingBox();
  const canvas = await page.getByTestId("scene-canvas").boundingBox();
  if (!toolbar || !canvas) throw new Error("no toolbar or canvas");
  expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(canvas.y + 1); // off the canvas

  const text = (id: string) => page.locator(`.agent-label[data-agent="${id}"] .agent-text`);
  await expect(text("ugv-007")).toHaveText("g07");
  await page.getByTestId("labels-full").click();
  await expect(text("ugv-007")).toHaveText("ugv-007");
  await page.getByTestId("labels-short").click();
  await expect(text("ugv-007")).toHaveText("g07");

  // 20 agents: eight solid, eight outline, four dashed, each with a colour of its own within its style.
  const count = (style: string) => page.locator(`.agent-label .agent-swatch.${style}`).count();
  expect([await count("solid"), await count("outline"), await count("dashed")]).toEqual([8, 8, 4]);
  const colours = await page.locator(".agent-label .agent-swatch.solid").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.getPropertyValue("--swatch")));
  expect(new Set(colours).size).toBe(8);

  for (const id of ["ugv-001", "ugv-020"]) {
    const row = await page.getByTestId(`explorer-row-${id}`).boundingBox();
    expect(row?.height).toBeCloseTo(24, 0);
  }
});

test("agents too close to label one by one share a chip with their count; zooming in gives the labels back", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "agents");
  const box = await page.getByTestId("scene-canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 14; k++) await page.mouse.wheel(0, 400);
  const chips = page.locator(".cluster-chip:not([hidden])");
  await expect.poll(() => chips.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(chips.first()).toHaveText(/^\d+ · /);
  // A member of a cluster has no label of its own on show.
  const hiddenLabels = await page.locator(".agent-label").evaluateAll((els) => els.filter((e) => (e as HTMLElement).style.display === "none").length);
  expect(hiddenLabels).toBeGreaterThanOrEqual(2);
});

test("the Overview and the Legend are floating windows, collapsed until opened", async ({ page }) => {
  test.setTimeout(120_000);
  await loadF2(page, "agents");
  await expect(page.getByTestId("overview-canvas")).toBeHidden();
  await page.getByTestId("wb-collapse-overview").click();
  const canvas = page.getByTestId("overview-canvas");
  await expect(canvas).toBeVisible();
  // The whole map, drawn: some of the pixels are not empty, and the agents are on it.
  await expect
    .poll(() => canvas.evaluate((c) => (c as HTMLCanvasElement).getContext("2d")?.getImageData(0, 0, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height).data.some((v, i) => i % 4 === 3 && v > 0)), { timeout: 10_000 })
    .toBe(true);
  await page.getByTestId("wb-collapse-overview").click();
  await expect(canvas).toBeHidden();

  await page.getByTestId("wb-collapse-legend").click();
  await expect(page.getByTestId("legend")).toContainText("g07");
  await expect(page.getByTestId("legend")).toContainText("cluster of agents");
  // The legend follows the overlays that are on.
  await expect(page.getByTestId("overlay-legend")).toHaveCount(0);
  await page.getByTestId("overlay-difference").click();
  await expect(page.getByTestId("overlay-legend")).toContainText("believed free, actually blocked");
});

test("a failed agent: badge and ring on the map, a row in the Explorer's attention group, the player's tile, a flag in the timeline", async ({ page }) => {
  test.setTimeout(150_000);
  await loadDemo(page);
  await expect(page.getByTestId("attention-tile")).toHaveText(/none|ATTENTION/);
  await sendTo(page, "ugv-001", 50, 45); // a closed box: unreachable
  await stepUntilEnded(page, 5);

  await expect(page.locator('.agent-label[data-agent="ugv-001"] .agent-badge')).toHaveText("✕ unreachable");
  await expect(page.locator('.agent-label[data-agent="ugv-001"] .agent-badge')).toHaveClass(/alarm/);
  const group = page.getByTestId("explorer-attention");
  await expect(group).toBeVisible();
  await expect(page.getByTestId("explorer-attention-ugv-001")).toContainText("✕ unreachable");
  // Alarms before warnings: the failed rover is above the low-battery one.
  const order = await group.locator('[data-testid^="explorer-attention-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order[0]).toBe("explorer-attention-ugv-001");
  await expect(page.getByTestId("attention-tile")).toHaveAttribute("data-level", "alarm");
  await expect(page.getByTestId("attention-tile")).toContainText("✕1");
  // The filter chips narrow the group.
  await page.getByTestId("attention-filter-warning").click();
  await expect(page.getByTestId("explorer-attention-ugv-001")).toHaveCount(0);
  await page.getByTestId("attention-filter-all").click();

  // The Timeline carries the failure as a flag, and counts it.
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("timeline-counts")).toContainText("✕ 1 failure");
});

test("the Inspector has an agent tab and a cell tab; the cell tab says what each agent believes, marked as researcher data", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("inspector-tab-agent")).toHaveAttribute("aria-selected", "true");
  // A click on a cell of the map selects it: the cell tab opens.
  const p = await page.evaluate(() => window.__agentsim?.scene?.screenOfGround(30.2, 20.2));
  await page.mouse.click(p?.x ?? 0, p?.y ?? 0);
  await expect(page.getByTestId("inspector-tab-cell")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("inspector-cell-truth")).toContainText("researcher");
  await expect(page.getByTestId("cell-beliefs-banner")).toContainText("not visible to the mind");
  for (const id of ["ugv-001", "ugv-002", "uav-001"]) await expect(page.getByTestId(`cell-belief-${id}`)).toBeVisible();
  // The demo's agents plan on the ground truth: ideal.
  await expect(page.getByTestId("cell-belief-ugv-001")).toHaveAttribute("data-state", "ideal");
  // The agent's tab is still there with its agent.
  await page.getByTestId("inspector-tab-agent").click();
  await expect(page.getByTestId("inspector-agent")).toContainText("ugv-001");
});
