import { expect, test, type Page } from "@playwright/test";
import { waitForStorageReady } from "./helpers.ts";

async function loadDemo(page: Page) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-demo v\d+$/);
  await page.keyboard.press("Escape");
}

const selection = (page: Page) => page.evaluate(() => window.__agentsim?.selection?.());

// F1 e4 (UI-SPEC §4, ADR-0016): Explorer and Inspector next to the Scene; selecting in one panel updates the
// others through the shared UI context.
test("Explorer, Scene and Inspector stay in sync; the Inspector shows state, configuration sources and cells", async ({ page }) => {
  await loadDemo(page);
  for (const id of ["uav-001", "ugv-001", "ugv-002"]) await expect(page.getByTestId(`explorer-row-${id}`)).toBeVisible();
  await expect(page.getByTestId("explorer-state-ugv-001")).toContainText("idle");

  // Explorer → UI context → Inspector.
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect.poll(() => selection(page)).toEqual({ kind: "agent", id: "ugv-001" });
  await expect(page.getByTestId("explorer-row-ugv-001")).toHaveAttribute("aria-selected", "true");
  const inspector = page.getByTestId("inspector-agent");
  await expect(inspector).toContainText("ugv-001");
  await expect(inspector).toContainText("rover");
  await expect(page.getByTestId("inspector-battery")).toContainText("100.0 %");
  // Each planning field shows the configuration level that supplied it (ADR-0028).
  await expect(page.getByTestId("inspector-config")).toContainText("algorithm");
  await expect(page.getByTestId("inspector-config")).toContainText("builtin");

  // Keyboard in the Explorer moves the selection.
  await page.getByRole("listbox", { name: "Agents" }).press("ArrowDown");
  await expect.poll(() => selection(page)).toEqual({ kind: "agent", id: "ugv-002" });
  await expect(page.getByTestId("inspector-battery")).toContainText("17.0 %");
  await expect(page.getByTestId("inspector-battery")).toContainText("critical 15 %");

  // Scene → Explorer + Inspector.
  const scout = await page.evaluate(() => window.__agentsim?.scene?.screenOf("uav-001"));
  await page.mouse.click(scout?.x ?? 0, scout?.y ?? 0);
  await expect.poll(() => selection(page)).toEqual({ kind: "agent", id: "uav-001" });
  await expect(page.getByTestId("explorer-row-uav-001")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("explorer-row-ugv-002")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("inspector-agent")).toContainText("uav-001");

  // A wall cell (x ∈ [30, 31), y < 50): blocked, unknown height → the air rule is stated.
  const wall = await page.evaluate(() => window.__agentsim?.scene?.screenOfGround(30.4, 20.2));
  await page.mouse.click(wall?.x ?? 0, wall?.y ?? 0);
  await expect.poll(() => selection(page)).toEqual({ kind: "cell", id: "60,40" });
  await expect(page.getByTestId("inspector-cell-occupancy")).toContainText("blocked");
  await expect(page.getByTestId("inspector-cell-air")).toContainText("unknown height");
});
