import { expect, test } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// F3b: the Debug workspace as a console (UI-SPEC §4, §6): the log with a prompt filter, kind toggles with their tags, zebra rows, a key footer; the Timeline with its
// legend in the title bar and the reflex and failure counts; the Inspector as an ID card and blocks.

const AGENT = "ugv-001";

test("the log: prompt, kind toggles with tags, zebra rows and the key footer", async ({ page }) => {
  test.setTimeout(150_000);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 20_000 });
  await openWorkspace(page, "debug");

  const prompt = page.getByRole("group", { name: "Filter" });
  await expect(prompt).toContainText("run-000001");
  await expect(prompt).toContainText("agent:");
  await expect(prompt).toContainText("kind: all");
  const rows = page.locator('[data-testid^="event-row-"]');
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(4);
  // Rows alternate (zebra), and each has its kind's tag.
  await expect(page.locator(".event-row.zebra").first()).toBeVisible();
  await expect(rows.first()).toContainText(/\[[A-Z]{3}\]/);

  // A kind off hides it; shift+click shows one alone; every chip is a toggle with a state.
  const action = page.getByTestId("event-kind-action");
  await expect(action).toHaveAttribute("aria-pressed", "true");
  await action.click();
  await expect(action).toHaveAttribute("aria-pressed", "false");
  await expect(prompt).not.toContainText("kind: all");
  await expect.poll(() => page.locator('[data-testid^="event-row-"][data-kind="action"]').count()).toBe(0);
  await action.click();
  await expect(prompt).toContainText("kind: all");
  await action.click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await page.locator('[data-testid^="event-row-"]:not([data-kind="action"])').count())).toBe(0);
  await expect(page.getByTestId("event-kind-reflex")).toHaveAttribute("aria-pressed", "false");

  // The footer follows the selection, and j/k move it.
  await expect(page.getByTestId("event-footer")).toContainText("nothing selected");
  await page.getByRole("listbox", { name: "Events" }).focus();
  await page.keyboard.press("j");
  await expect(page.getByTestId("event-footer")).toContainText(/sel #\d+ · ACT/);
  const first = await page.getByTestId("event-footer").textContent();
  await page.keyboard.press("j");
  await expect(page.getByTestId("event-footer")).not.toHaveText(first ?? "");
  await page.keyboard.press("k");
  await expect(page.getByTestId("event-footer")).toHaveText(first ?? "");
});

test("the timeline has its legend in the title bar and counts the flags; the Inspector has an ID card", async ({ page }) => {
  test.setTimeout(150_000);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 20_000 });
  await openWorkspace(page, "debug");

  const legend = page.getByTestId("timeline-legend");
  await expect(legend).toBeVisible();
  for (const word of ["action", "failure", "reflex", "snapshot"]) await expect(legend).toContainText(word);
  await expect(page.getByTestId("timeline-counts")).toHaveText(/▲ \d+ reflex · ✕ \d+ failure/);
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();

  // The Inspector of the selected agent: the card first, with what it is doing.
  const card = page.getByTestId("inspector-idcard");
  await expect(card).toContainText(AGENT);
  await expect(page.getByTestId("inspector-idcard-state")).toContainText("explore");
  // Blocks have ruled titles (the title is followed by a rule).
  await expect(page.getByTestId("inspector-state").locator("h4")).toBeVisible();
  await expect(page.getByTestId("inspector-battery")).toContainText("%");
});
