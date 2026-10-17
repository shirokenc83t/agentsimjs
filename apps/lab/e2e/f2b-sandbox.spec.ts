import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, step } from "./helpers.ts";

/** A new run of the demo whose agents plan on `unknown` belief maps (the F1 demo's own agents are `ideal`). */
async function runWithUnknownMaps(page: Page) {
  await openWorkspace(page, "author");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-beliefs-init").selectOption("unknown");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await openWorkspace(page, "scene");
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().chunksPending)).toBe(0);
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("inspector-strategy-test")).toBeVisible();
}

async function testTo(page: Page, x: number, y: number) {
  await page.getByTestId("st-x").fill(String(x));
  await page.getByTestId("st-y").fill(String(y));
  await page.getByTestId("st-run").click();
}

const sandboxDrawn = (page: Page) => page.evaluate(() => window.__agentsim?.scene?.overlays().sandbox);

async function stateHash(page: Page): Promise<string> {
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("state-hash")).toHaveText(/^[0-9a-f]{8} @ tick \d+$/);
  const text = (await page.getByTestId("state-hash").textContent()) ?? "";
  await page.keyboard.press("Escape");
  return text;
}

// ADR-0037 item 16: the sandbox plans apart from the run, on the agent's belief map by default, on the ground truth by choice.
test("the Strategy test plans on the belief map by default and on the ground truth by choice, marked as researcher data", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await runWithUnknownMaps(page);

  // The demo's closed box at (50, 40): an unknown map has no wall there, the ground truth has.
  await page.getByTestId("st-strategy").selectOption("astar-then-hpa@1");
  await testTo(page, 50, 40);
  await expect(page.getByTestId("st-status")).toContainText("✓ found");
  await expect(page.getByTestId("st-status")).toContainText("strategy:astar-then-hpa@1");
  await expect(page.getByTestId("st-source")).toContainText("belief map");
  await expect(page.getByTestId("st-result-researcher")).toHaveCount(0);
  await expect(page.getByTestId("plan-query-detail")).toContainText("astar");
  await expect.poll(async () => (await sandboxDrawn(page))?.legSegments ?? 0).toBeGreaterThan(0);
  await expect(page.getByTestId("sandbox-legend")).toContainText("Strategy test result");

  await page.getByTestId("st-map").selectOption("truth");
  await expect(page.getByTestId("st-researcher-banner")).toContainText("Researcher view — not visible to the mind");
  await page.getByTestId("st-run").click();
  await expect(page.getByTestId("st-status")).toContainText("✕ not_found");
  await expect(page.getByTestId("st-source")).toContainText("ground truth");
  await expect(page.getByTestId("st-result-researcher")).toContainText("Researcher view — not visible to the mind");
  await expect.poll(async () => (await sandboxDrawn(page))?.legSegments ?? -1).toBe(0);

  await page.getByTestId("st-clear").click();
  await expect(page.getByTestId("st-status")).toHaveCount(0);
});

test("refusals show their stable code and path, and nothing is drawn", async ({ page }) => {
  await loadDemo(page);
  await runWithUnknownMaps(page);
  await page.getByTestId("st-strategy").selectOption("inline");
  await page.getByTestId("st-json").fill(
    JSON.stringify({ schemaVersion: 0, id: "bad", version: 1, origin: "human", root: { kind: "select", branches: [{ when: "nonsense > 1", then: { kind: "algorithm", algorithm: "astar" } }], else: { kind: "algorithm", algorithm: "hpa" } } }),
  );
  await testTo(page, 30, 30);
  await expect(page.getByTestId("st-error")).toContainText("expr_unknown_name");
  await expect(page.getByTestId("st-error")).toContainText("/strategy");
  expect((await sandboxDrawn(page))?.legSegments).toBe(0);
  await page.getByTestId("st-json").fill("{ not json");
  await expect(page.getByTestId("st-json-error")).toContainText("invalid_json");
  await expect(page.getByTestId("st-run")).toBeDisabled();
});

test("the target can be picked on the map: the next ground click fills it, and is not a command", async ({ page }) => {
  await loadDemo(page);
  await runWithUnknownMaps(page);
  await page.getByTestId("st-pick").click();
  await expect(page.getByTestId("scene-sandbox-picking")).toBeVisible();
  const p = await page.evaluate(() => window.__agentsim?.scene?.screenOfGround(30, 30));
  await page.mouse.click(p?.x ?? 0, p?.y ?? 0);
  await expect(page.getByTestId("scene-sandbox-picking")).toHaveCount(0);
  await expect.poll(async () => Number(await page.getByTestId("st-x").inputValue())).toBeGreaterThan(28);
  expect(Number(await page.getByTestId("st-x").inputValue())).toBeLessThan(32);
  // The pick was not a send-to: the rover has no command in its record.
  await expect(page.getByTestId("inspector-command-result")).toContainText("none yet");
});

// The purity claim, from the UI: sandbox runs during a live run leave the run's state hash as it was.
test("running Strategy tests during a run does not change the run's state hash", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await runWithUnknownMaps(page);
  await step(page, 1);
  for (const map of ["belief", "truth"] as const) {
    await page.getByTestId("st-map").selectOption(map);
    await testTo(page, 50, 10);
    await expect(page.getByTestId("st-status")).toBeVisible();
  }
  await step(page, 1);
  const probed = await stateHash(page);

  // The same run again (same configuration), without any Strategy test.
  await page.getByTestId("run-label").click();
  await page.getByTestId("rerun").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  await page.keyboard.press("Escape");
  await step(page, 2);
  const control = await stateHash(page);
  expect(probed).toBe(control);
});
