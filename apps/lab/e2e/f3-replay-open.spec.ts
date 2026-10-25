import { expect, test, type Page } from "@playwright/test";
import { countSimMessages, loadDemo, openInspectorSections, openWorkspace, setReplayCursor as setCursor, simMessages, step } from "./helpers.ts";

// F3a M3: a recorded run is opened in the panels from the Storage browser and read from storage alone. The sim worker receives no `load`,
// `step`, `control` or `command` message during the session; the pose, battery and path of an agent at the cursor are what the live run had at that time.

const FORBIDDEN = ["load", "control", "command", "buildPreset", "strategyTest", "step"];

async function stateOf(page: Page, agent: string): Promise<string> {
  await page.getByTestId(`explorer-row-${agent}`).click();
  await openInspectorSections(page);
  const text = (await page.getByTestId("inspector-state").textContent()) ?? "";
  return text;
}

test("a recorded run opens in the panels from the Storage browser; the sim worker is not touched; what it shows is what the live run had", async ({ page }) => {
  test.setTimeout(120_000);
  await countSimMessages(page);
  await loadDemo(page);
  await page.getByTestId("run-label").click();
  const first = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await step(page, 2); // 200 ticks (20 s)
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 15_000 });

  // A second run of the same scenario, stepped to 10 s: the state the first run had then (same scenario, no commands: the same run).
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(first);
  await page.keyboard.press("Escape");
  await step(page, 1);
  const agent = "ugv-001";
  const live = await stateOf(page, agent);
  expect(live).toContain("position");

  // Open the first run for replay: from the Storage browser.
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId(`replay-${first}`)).toBeEnabled();
  const mark = (await simMessages(page)).length;
  await page.getByTestId(`replay-${first}`).click();
  // The Data workspace has no Scene: opening a recording takes the user to the Debug workspace, where the replay bar of that run is, without navigating by hand.
  await expect(page.getByTestId("workspace-debug")).toBeVisible();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("replay-label")).toContainText(first);
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("replay-bar")).toBeVisible();
  await expect(page.getByTestId("replay-label")).toContainText(first);
  await expect(page.getByTestId("replay-pose-rate")).toContainText("Hz");
  await expect(page.getByTestId("replay-time")).toContainText("20.0 s"); // the recording ends at tick 200
  await setCursor(page, 10);
  const replayed = await stateOf(page, agent);
  expect(replayed).toBe(live);
  // The features that need the live run say so.
  await expect(page.getByTestId("inspector-off-mindView")).toContainText("Not available in replay");
  await expect(page.getByTestId("overlay-rays")).toBeDisabled();
  // The Cell tab is off in a replay, with its reason, not hidden and not empty.
  await expect(page.getByTestId("inspector-tab-cell")).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("inspector-tab-cell").click({ force: true }); // aria-disabled, but it still explains itself (Playwright does not click what is aria-disabled)
  await expect(page.getByTestId("inspector-cell-off")).toContainText("live only");
  await page.getByTestId("inspector-tab-agent").click();
  // Moving the cursor and picking things went to storage, not to the sim worker.
  await setCursor(page, 3);
  await setCursor(page, 17.5);
  const during = (await simMessages(page)).slice(mark);
  expect(during.filter((t) => FORBIDDEN.includes(t)), `messages to the sim worker during the replay: ${during.join(", ")}`).toEqual([]);

  // Back to the live run.
  await page.getByTestId("replay-close").click();
  await expect(page.getByTestId("replay-bar")).toHaveCount(0);
  expect(await stateOf(page, agent)).toBe(live);
});

test("a run that was not recorded offers no replay, and says why", async ({ page }) => {
  await loadDemo(page);
  await page.getByTestId("run-label").click();
  const recorded = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.getByTestId("recording-opt-out").check();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(recorded);
  const id = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await step(page, 1);
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  const button = page.getByTestId(`replay-${id}`);
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("title", /not recorded/);
});
