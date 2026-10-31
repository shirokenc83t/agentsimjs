import { expect, test, type Page } from "@playwright/test";
import { loadF2, openPanelTab, openWorkspace } from "./helpers.ts";

// F4 M4 (T-125): the `minds` table of the run configuration: an agent gets a language-model mind from a profile of the Library, the row says what is wrong with it (a provider Settings does not have), the mission has
// its counter, the estimate is set against the limits, and what the table shows as effective is what the run's `config` record says.

const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local-ollama", model: "qwen2.5:7b", promptTemplate: { id: "default", version: 1 } } };

async function importProfile(page: Page) {
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Library");
  await page.getByTestId("lib-import-file").setInputFiles({ name: "scout-llm.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(PROFILE)) });
  await expect(page.getByTestId("lib-message")).toContainText("imported as scout-llm v1");
}
async function addProvider(page: Page) {
  await openWorkspace(page, "settings");
  await page.getByTestId("pv-add").click();
  await page.getByTestId("pv-name").fill("local-ollama");
  await page.getByTestId("pv-address").fill("http://localhost:11434");
  await page.getByTestId("pv-save").click();
  await expect(page.getByTestId("pv-row-local-ollama")).toBeVisible();
}

test("an agent gets a language-model mind: the row's error until the provider exists, the mission and its counter, the estimate against the limits, the run mode, and the effective configuration of the run", async ({ page }) => {
  test.setTimeout(180_000);
  await loadF2(page, "discovery");
  await importProfile(page);
  await openPanelTab(page, "Run configuration");
  const row = page.getByTestId("rc-minds-row-scout");
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId("rc-minds-kind-scout").selectOption("s2");
  await expect(page.getByTestId("rc-minds-profile-scout")).toHaveValue("scout-llm@1");
  // The provider the profile names is not in Settings: the row says so, with the stable code.
  await expect(page.getByTestId("rc-minds-error-scout")).toContainText("provider_not_configured");
  await expect(page.getByTestId("rc-status-minds")).toHaveText("✕");
  await addProvider(page);
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  // The draft belongs to the panel and starts again from the run when the workspace is left: the agent gets its mind again, now with a provider to name.
  await page.getByTestId("rc-minds-row-scout").scrollIntoViewIfNeeded();
  await page.getByTestId("rc-minds-kind-scout").selectOption("s2");
  await expect(page.getByTestId("rc-minds-error-scout")).toHaveCount(0);
  await expect(page.getByTestId("rc-status-minds")).toHaveText("✓");
  await expect(page.getByTestId("rc-minds-provider-scout")).toContainText("local-ollama");
  // The mission and its counter (≤ 2 000 characters); the estimate follows it.
  const mission = "Inspect P1 (20, 40), P2 (50, 20) and P3 (70, 55), then return to base and land.";
  await page.getByTestId("rc-minds-mission-scout").fill(mission);
  await expect(page.getByTestId("rc-minds-count-scout")).toHaveText(`${mission.length} / 2000`);
  await expect(page.getByTestId("rc-minds-est-calls-scout")).toHaveText("9–17 of 20");
  await expect(page.getByTestId("rc-minds-est-cost-scout")).toHaveText("no prices");
  // An override of the token limit raises the limit the estimate is set against, and is in the effective configuration.
  await page.getByTestId("rc-minds-tokens-scout").fill("60000");
  await expect(page.getByTestId("rc-minds-est-tokens-scout")).toContainText("of 60k");
  const effective = page.getByTestId("rc-minds-effective-scout");
  await expect(effective).toContainText("qwen2.5:7b");
  await expect(effective).toContainText("60 000 tok");
  // The run mode is written by omission for live, and the others are chosen here.
  await expect(page.getByTestId("rc-minds-mode-live")).toBeChecked();
  await page.getByTestId("rc-minds-mode-replay-strict").check();
  await expect(page.getByTestId("rc-minds-mode-replay-strict")).toBeChecked();
  await page.getByTestId("rc-minds-mode-live").check();

  // Run it: the run's config record says what the table said.
  await page.getByTestId("rc-run").click();
  await openWorkspace(page, "data");
  await page.getByTestId("sql-editor").fill("SELECT payload FROM trace_records WHERE agent_id = 'uav-001' AND payload LIKE '%mindS2%' ORDER BY seq DESC LIMIT 1");
  await page.getByTestId("sql-run").click();
  await expect(page.getByTestId("sql-status")).toContainText(/rows?/, { timeout: 30_000 });
  const cell = (await page.getByTestId("sql-grid").textContent()) ?? "";
  expect(cell).toContain('"model":"qwen2.5:7b"');
  expect(cell).toContain('"tokens":60000');
  expect(cell).toContain('"mission":"Inspect P1');
  expect(cell).toContain("localhost:11434");
});
