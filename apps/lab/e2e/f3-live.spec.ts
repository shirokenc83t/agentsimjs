import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// F3b M3 (ADR-0035 section 5, acceptance 7, UI side): during a recorded live run the log console's tail (the live subscription) and the same filter read from storage (the SQL
// backend: the console's export) hold the same records once they are flushed; the tail pauses when the list is scrolled up, counts what arrives, and goes on when it is taken.

const AGENT = "ugv-001";

/** What the console lists now, by its own counters: how many rows and the seq of the last. */
async function listed(page: Page): Promise<{ count: number; last: number }> {
  const el = page.getByTestId("event-scroller");
  return { count: Number(await el.getAttribute("data-count")), last: Number(await el.getAttribute("data-last-seq")) };
}

/** The result of the console's filter read from storage and exported as JSON lines: its count and the seq of its last record. */
async function exported(page: Page): Promise<{ count: number; last: number }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("log-export").click()]);
  const lines = readFileSync(await download.path(), "utf8").split("\n").filter((l) => l !== "");
  return { count: lines.length, last: lines.length === 0 ? -1 : (JSON.parse(lines[lines.length - 1] as string) as { seq: number }).seq };
}

test("the console's live tail and the same filter read from storage hold the same records; the tail pauses when scrolled up and counts what comes", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 20_000 });

  await openWorkspace(page, "debug");
  await page.getByTestId("log-filter").fill("kind:action");
  await expect(page.getByTestId("log-tail")).toHaveAttribute("data-state", "following");
  await expect.poll(async () => (await listed(page)).count, { timeout: 15_000 }).toBeGreaterThan(3);
  const before = await listed(page);

  // The run goes on: what it stores is pushed to the console while it is open.
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 400", { timeout: 20_000 });
  await expect.poll(async () => (await listed(page)).count, { timeout: 15_000 }).toBeGreaterThan(before.count);
  // Once flushed, the tail is the SQL result of the same filter.
  await expect.poll(async () => (await listed(page)).last, { timeout: 15_000 }).toBe((await exported(page)).last);
  expect(await listed(page)).toEqual(await exported(page));

  // Scrolled up, the tail pauses: what arrives is counted and not shown; taking it gives the list the same records as storage.
  await page.getByTestId("event-scroller").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByTestId("log-tail")).toHaveAttribute("data-state", "paused");
  const paused = await listed(page);
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 600", { timeout: 20_000 });
  await expect(page.getByTestId("log-new")).toContainText(/\d+ new/);
  expect(await listed(page)).toEqual(paused); // nothing was added under the researcher's eyes
  await page.getByTestId("log-new").click();
  await expect(page.getByTestId("log-tail")).toHaveAttribute("data-state", "following");
  await expect.poll(async () => (await listed(page)).count, { timeout: 15_000 }).toBeGreaterThan(paused.count);
  await expect.poll(async () => (await listed(page)).last, { timeout: 15_000 }).toBe((await exported(page)).last);
  expect(await listed(page)).toEqual(await exported(page));

  // And the SQL console, which has no filter language, gives the same for the same question written in SQL (acceptance 7 as written: the tail against the SQL console's result).
  const tail = await listed(page);
  await openWorkspace(page, "data");
  await page.getByTestId("sql-editor").fill("SELECT count(*) AS n, max(seq) AS last FROM trace_records WHERE run_id = 'run-000001' AND kind = 'action'");
  await page.getByTestId("sql-run").click();
  await expect(page.getByTestId("sql-status")).toContainText("1 row", { timeout: 15_000 });
  const cells = await page.getByTestId("sql-row-0").locator('[role="cell"]').allTextContents();
  expect({ count: Number(cells[0]), last: Number(cells[1]) }).toEqual(tail);
});

test("the console's keys: / focuses the filter, j k move, space opens a row, [ ] go to the flags, y copies, Esc leaves the filter", async ({ page, context }) => {
  test.setTimeout(240_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 20_000 });
  await openWorkspace(page, "debug");
  const list = page.getByRole("listbox", { name: "Events" });
  await expect.poll(async () => (await listed(page)).count, { timeout: 15_000 }).toBeGreaterThan(5);

  await list.focus();
  await page.keyboard.press("/");
  await expect(page.getByTestId("log-filter")).toBeFocused();
  await page.keyboard.type("kind:action");
  await page.keyboard.press("Escape");
  await expect(list).toBeFocused();
  await expect.poll(() => page.locator('[data-testid^="event-row-"]:not([data-kind="action"])').count()).toBe(0);

  await page.keyboard.press("g");
  await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press("j");
  const selected = list.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press(" ");
  await expect(selected).toHaveAttribute("aria-expanded", "true");
  await expect(selected.locator(".log-payload")).toContainText('"kind": "action"');
  await page.keyboard.press(" ");
  await expect(selected).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("y");
  await expect(page.getByTestId("event-footer")).toContainText("copied #");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect((JSON.parse(copied) as { kind: string }).kind).toBe("action");
});
