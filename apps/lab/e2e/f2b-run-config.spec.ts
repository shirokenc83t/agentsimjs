import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openPanelTab, openWorkspace, sendTo, step } from "./helpers.ts";

const astar = { kind: "algorithm", algorithm: "astar" };
const hpa = { kind: "algorithm", algorithm: "hpa" };
const inline = (root: unknown) => JSON.stringify({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root });

async function openRunConfig(page: Page) {
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  return panel;
}

/** Sends the rover 30 m east, runs 100 ticks and returns the run's state hash. */
async function hashAfterGoTo(page: Page): Promise<string> {
  await openWorkspace(page, "scene");
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().chunksPending)).toBe(0);
  await sendTo(page, "ugv-001", 40, 10);
  await step(page, 1);
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("state-hash")).toHaveText(/^[0-9a-f]{8} @ tick 100$/);
  const text = (await page.getByTestId("state-hash").textContent()) ?? "";
  await page.keyboard.press("Escape");
  return text;
}

// ROADMAP F2b acceptance: `algorithm: X` and the equivalent one-node strategy give identical state hashes.
test("an algorithm and its one-node strategy give the same state hash, chosen in the run configuration", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);

  let panel = await openRunConfig(page);
  await panel.getByTestId("rc-algorithm").selectOption("astar");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await expect(panel.getByTestId("rc-effective-ugv-001")).toContainText("astar");
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  const plain = await hashAfterGoTo(page);

  panel = await openRunConfig(page);
  await panel.getByTestId("rc-planner").selectOption("strategy");
  await panel.getByTestId("rc-strategy-preset").selectOption("astar-only@1");
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await expect(panel.getByTestId("rc-effective-ugv-001")).toContainText("strategy:astar-only@1");
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");
  const viaStrategy = await hashAfterGoTo(page);

  expect(viaStrategy).toBe(plain);
});

// ROADMAP F2b acceptance: unknown names and malicious inputs are rejected with stable codes; nothing runs.
test("an inline strategy with an unknown name, a code-like condition or a misplaced lazy refine is rejected with its code and cannot be run", async ({ page }) => {
  await loadDemo(page);
  const panel = await openRunConfig(page);
  await panel.getByTestId("rc-planner").selectOption("strategy");
  await panel.getByTestId("rc-strategy-preset").selectOption("inline");
  const editor = panel.getByTestId("rc-strategy-json");
  const rejected = async (root: unknown, code: string) => {
    await editor.fill(inline(root));
    await expect(panel.getByTestId("rc-strategy-error")).toContainText(code);
    await expect(panel.getByTestId("rc-error")).toContainText(code);
    await expect(panel.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "true");
  };

  await rejected({ kind: "select", branches: [{ when: "nonsense > 1", then: astar }], else: hpa }, "expr_unknown_name");
  await rejected({ kind: "select", branches: [{ when: "globalThis.alert(1)", then: astar }], else: hpa }, "expr_");
  await rejected({ kind: "fallback", stages: [astar, { kind: "refine", mode: "lazy", coarse: hpa, local: astar }] }, "invalid_strategy");

  await editor.fill("{ not json");
  await expect(panel.getByTestId("rc-strategy-json-error")).toContainText("invalid_json");

  // A valid document clears every message.
  await editor.fill(inline({ kind: "select", branches: [{ when: "dist.m <= 100", then: astar }], else: hpa }));
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await expect(panel.getByTestId("rc-strategy-error")).toHaveCount(0);
  await expect(panel.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "false");
});

// ADR-0037 sixth and seventh additions: a lazy refine on agents that plan on a belief map is warned about, never blocked.
test("a lazy refine on agents with a belief map shows a warning in the run configuration and in the Inspector, and still runs", async ({ page }) => {
  test.setTimeout(90_000);
  await loadDemo(page);
  const panel = await openRunConfig(page);
  await panel.getByTestId("rc-beliefs-init").selectOption("unknown");
  await panel.getByTestId("rc-planner").selectOption("strategy");
  await panel.getByTestId("rc-strategy-preset").selectOption("inline");
  await panel.getByTestId("rc-strategy-json").fill(inline({ kind: "refine", mode: "lazy", coarse: hpa, local: astar }));
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await expect(panel.getByTestId("rc-warning-ugv-001")).toContainText("lazy_refine_on_belief_map");
  await expect(panel.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "false");
  await panel.getByTestId("rc-run").click();
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");

  await openWorkspace(page, "scene");
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("inspector-config-warning-lazy_refine_on_belief_map")).toContainText("belief map");
  await expect(page.getByTestId("inspector-strategy")).toContainText("strategy:mine@1");
});
