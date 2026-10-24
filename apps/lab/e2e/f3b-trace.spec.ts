import { expect, test, type Page } from "@playwright/test";
import { loadDemo, loadF2, openWorkspace, runCommand, sendTo, step } from "./helpers.ts";

// F3b M3/M4 (UI-SPEC section 4): the trace tree around a record picked in the log: its parents, what it was caused by, its children and effects. The action runtime writes
// `parentId` and `causeIds` for what exists today (the records of an action belong to its start; the event the world raises about an ended action is caused by its end), so the tree
// shows real runs: nothing here edits a recording.

const AGENT = "ugv-001";

/** The docked tree lists one part at a time behind its toggles: open the part to look at. */
async function part(page: Page, name: "parents" | "causes" | "children" | "effects"): Promise<void> {
  await page.getByTestId(`tt-tab-${name}`).click();
  await expect(page.getByTestId(`tt-${name}`)).toBeVisible();
}

async function explored(page: Page): Promise<void> {
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 20_000 });
}

/** The log shows only what the filter selects, and its list is that filter's (not the previous one still on screen). */
async function filtered(page: Page, text: string, kind: string): Promise<void> {
  await page.getByTestId("log-filter").fill(text);
  await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator(`[data-testid^="event-row-"]:not([data-kind="${kind}"])`)).toHaveCount(0);
  // The list of a run being recorded follows its tail: take it to the top, where the first records are.
  await page.getByTestId("event-scroller").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(300); // a list that does not scroll (few rows) goes on following; one that does is paused here
}

test("the trace tree on a real run: the start of an action has the action's records as its children, and each of them has the start as its parent; a click on a node picks that record, and the log and the cursor follow", async ({ page }) => {
  test.setTimeout(240_000);
  await explored(page);
  await openWorkspace(page, "debug");
  await expect(page.getByTestId("trace-tree")).toBeVisible(); // under the Log
  await expect(page.getByTestId("trace-tree-empty")).toBeVisible();

  // The start of an action (the first record of the agent's actions): its children are what the action wrote while it ran.
  await filtered(page, `kind:action agent:${AGENT}`, "action");
  const first = page.locator('[data-testid^="event-row-"]').first();
  await expect(first).toContainText("start");
  await first.click();
  const selected = page.getByTestId("trace-tree-selected");
  await expect(selected).toBeVisible();
  const startSeq = Number(await selected.getAttribute("data-seq"));
  const child = page.getByTestId("tt-children").locator('[data-testid^="trace-node-"]').first();
  await expect(child).toBeVisible({ timeout: 15_000 });
  await part(page, "parents");
  await expect(page.getByTestId("tt-parents")).toContainText("none"); // a start has no parent
  await part(page, "children");

  // One of the records of the action: the tree shows the start as its parent; a click on the parent picks the start, and the log and the cursor follow.
  const childSeq = Number(await child.getAttribute("data-seq"));
  await child.click();
  await expect(selected).toHaveAttribute("data-seq", String(childSeq));
  await part(page, "parents");
  await expect(page.getByTestId("tt-parents")).toContainText("start");
  const parent = page.getByTestId("tt-parents").locator('[data-testid^="trace-node-"]').first();
  await expect(parent).toHaveAttribute("data-seq", String(startSeq));
  await parent.click();
  await expect(selected).toHaveAttribute("data-seq", String(startSeq));
  await expect(page.getByTestId("tt-children").locator(`[data-seq="${childSeq}"]`)).toBeVisible({ timeout: 15_000 });
  const t = Number((await page.getByTestId("tt-record").textContent())?.match(/(\d+\.\d+) s/)?.[1] ?? "NaN");
  await expect(page.getByTestId("replay-time")).toContainText(`${t.toFixed(1)} s /`, { timeout: 15_000 });
  await expect(page.locator(`[data-testid="event-row-${startSeq}"][aria-selected="true"]`)).toBeVisible({ timeout: 10_000 });
  // Another filter does not leave the log and the tree speaking of two records.
  await page.getByTestId("log-filter").fill("kind:snapshot");
  await expect(page.getByTestId("event-detail")).toContainText(`"seq": ${startSeq}`, { timeout: 10_000 });
  await expect(selected).toHaveAttribute("data-seq", String(startSeq));
});

test("the event a mind is told about an ended action is caused by the action's end, which belongs to its start (the F1 demo, a command from the researcher)", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);
  await sendTo(page, "ugv-001", 50, 10); // a command from the researcher: the rover drives there and the action ends
  await step(page, 5);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 500", { timeout: 30_000 });
  await openWorkspace(page, "debug");
  await filtered(page, "kind:event text:actionCompleted", "event");
  await page.locator('[data-testid^="event-row-"]').first().click();
  await part(page, "causes");
  const cause = page.getByTestId("tt-causes").locator('[data-testid^="trace-node-"]').first();
  await expect(cause).toBeVisible({ timeout: 15_000 });
  await expect(cause).toContainText("end");
  await cause.click();
  await part(page, "parents");
  await expect(page.getByTestId("tt-parents")).toContainText("start");
  await part(page, "effects");
  await expect(page.getByTestId("tt-effects")).toContainText("event"); // the event about it
});
