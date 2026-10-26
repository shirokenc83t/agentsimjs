import { expect, test } from "@playwright/test";
import { loadDemo, loadF2, openInspectorSections, openPanelTab, openWorkspace } from "./helpers.ts";

// ADR-0028 addition of 2026-10-09: `ideal` agents plan on the ground truth and are labelled wherever they appear.
test("ideal agents are labelled in the Explorer and the Inspector; the F2 demos start unknown; the run configuration sets the initial map", async ({ page }) => {
  test.setTimeout(120_000);

  // The F1 demo runs ideal agents (the map it was designed for).
  await loadDemo(page);
  for (const id of ["ugv-001", "ugv-002", "uav-001"]) await expect(page.getByTestId(`explorer-ideal-${id}`)).toBeVisible();
  await page.getByTestId("explorer-row-ugv-001").click();
  await openInspectorSections(page);
  await expect(page.getByTestId("inspector-init")).toContainText("ideal");

  // The F2 discovery demo starts every agent from an unknown map: no label, the Inspector says so.
  await loadF2(page, "discovery");
  await expect(page.getByTestId("explorer-ideal-ugv-001")).toHaveCount(0);
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("inspector-init")).toContainText("unknown");

  // Run configuration → Beliefs: make only the rover ideal; the effective table shows it; the new run labels it.
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-beliefs-scope").selectOption("byAgent.rover");
  await panel.getByTestId("rc-beliefs-init").selectOption("ideal");
  await expect(panel.getByTestId("rc-effective-init-ugv-001")).toContainText("ideal");
  await expect(panel.getByTestId("rc-effective-init-ugv-002")).toContainText("unknown");
  await panel.getByTestId("rc-run").click();
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("explorer-ideal-ugv-001")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("explorer-ideal-ugv-002")).toHaveCount(0);
  await expect(page.getByTestId("explorer-ideal-uav-001")).toHaveCount(0);
});
