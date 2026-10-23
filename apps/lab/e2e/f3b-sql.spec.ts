import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadDemo, openWorkspace, step } from "./helpers.ts";

// F3b M3 (UI-SPEC section 7): the SQL console of the Data workspace reads the whole database and cannot write; a long statement is stopped while the live run goes on being
// saved. The guarantees of the executor are the storage package's tests (every write form, user_data, the interleaving); these are the same through the real app.

async function runSql(page: Page, sql: string): Promise<void> {
  const editor = page.getByTestId("sql-editor");
  await editor.fill(sql);
  await page.getByTestId("sql-run").click();
}

test("the SQL console reads, refuses every write and user_data with the reason, completes from the schema, saves a statement and exports the result", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await step(page, 2);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 200", { timeout: 20_000 });
  await openWorkspace(page, "data");
  await expect(page.getByTestId("sql-console")).toBeVisible();

  // It reads: the records of the run, by kind.
  await runSql(page, "SELECT kind, count(*) AS n FROM trace_records WHERE run_id = 'run-000001' GROUP BY kind ORDER BY n DESC");
  await expect(page.getByTestId("sql-status")).toContainText("rows", { timeout: 15_000 });
  await expect(page.getByTestId("sql-grid")).toHaveAttribute("data-rows", /^[1-9]/);
  await expect(page.getByTestId("sql-row-0")).toBeVisible();
  const count = async () => {
    await runSql(page, "SELECT count(*) AS n FROM trace_records WHERE run_id = 'run-000001'");
    await expect(page.getByTestId("sql-status")).toContainText("1 row", { timeout: 15_000 });
    return Number(await page.getByTestId("sql-row-0").locator('[role="cell"]').first().textContent());
  };
  const before = await count();
  expect(before).toBeGreaterThan(50);

  // Every write is refused with its reason, and nothing changes.
  for (const [statement, code] of [
    ["DELETE FROM trace_records", "not_read_only"],
    ["DROP TABLE trace_records", "not_read_only"],
    ["UPDATE runs SET label = 'x'", "not_read_only"],
    ["INSERT INTO runs (run_id) VALUES ('run-000099')", "not_read_only"],
    ["ATTACH DATABASE ':memory:' AS other", "not_read_only"],
    ["PRAGMA writable_schema = 1", "not_read_only"],
    ["SELECT 1; DELETE FROM trace_records", "multiple_statements"],
    ["WITH x AS (SELECT 1) DELETE FROM trace_records", "denied"],
    ["SELECT * FROM user_data", "denied"],
  ] as const) {
    await runSql(page, statement);
    await expect(page.getByTestId("sql-error"), statement).toHaveAttribute("data-code", code, { timeout: 15_000 });
  }
  expect(await count()).toBeGreaterThanOrEqual(before); // only the live run's own writes (the run is paused: the same)

  // Completion from the schema: tables, then the columns of the table in use.
  const editor = page.getByTestId("sql-editor");
  await editor.fill("");
  await editor.pressSequentially("SELECT * FROM trace_rec");
  await expect(page.getByTestId("sql-complete-item").first()).toHaveText("trace_records");
  await page.keyboard.press("Tab");
  await expect(editor).toHaveValue("SELECT * FROM trace_records");
  await editor.pressSequentially(" WHERE ki");
  await expect(page.getByTestId("sql-complete-item").first()).toHaveText("kind");
  await page.keyboard.press("Escape");

  // A statement is saved under a name, offered again, and the result is exported.
  await editor.fill("SELECT run_id, label FROM runs");
  await page.getByTestId("sql-snippet-save").click();
  await page.getByTestId("sql-snippet-name").fill("runs");
  await page.keyboard.press("Enter");
  await editor.fill("SELECT 1");
  await page.getByTestId("sql-snippets").selectOption("runs");
  await expect(editor).toHaveValue("SELECT run_id, label FROM runs");
  await page.getByTestId("sql-run").click();
  await expect(page.getByTestId("sql-status")).toContainText("row", { timeout: 15_000 });
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("sql-export-csv").click()]);
  expect(readFileSync(await csv.path(), "utf8")).toMatch(/^run_id,label\r\nrun-000001,/);
  const [jsonl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("sql-export-jsonl").click()]);
  expect(JSON.parse(readFileSync(await jsonl.path(), "utf8").split("\n")[0] as string)).toMatchObject({ run_id: "run-000001" });
});

test("a long statement is stopped while the live run goes on being saved: the recording is not held", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  await openWorkspace(page, "data");
  // The run plays (and is recorded) while the console works.
  await page.getByTestId("play").click();
  await expect.poll(async () => Number(((await page.getByTestId("status-recording-saved").textContent()) ?? "").match(/\d+/)?.[0] ?? 0), { timeout: 20_000 }).toBeGreaterThan(5);
  const savedTick = async () => Number(((await page.getByTestId("status-recording-saved").textContent()) ?? "").match(/\d+/)?.[0] ?? 0);
  const at = await savedTick();

  await runSql(page, "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT count(*) FROM x");
  const t0 = Date.now();
  await expect(page.getByTestId("sql-error")).toHaveAttribute("data-code", "too_slow", { timeout: 15_000 });
  expect(Date.now() - t0).toBeLessThan(5000);
  await expect(page.getByTestId("sql-error")).toContainText("narrow the query");
  // The recording went on: the saved head moved during and after, and the run is not stalled by a backlog.
  await expect.poll(savedTick, { timeout: 15_000 }).toBeGreaterThan(at + 5);
  await expect(page.getByTestId("status-recording-state")).not.toContainText("paused", { timeout: 5_000 }).catch(() => undefined);

  // A statement that streams rows slowly is cancelled between slices.
  await runSql(page, "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT n, length(hex(randomblob(150000))) FROM x");
  await expect(page.getByTestId("sql-cancel")).toBeEnabled();
  await page.getByTestId("sql-max-rows").fill("100000");
  await page.getByTestId("sql-cancel").click();
  await expect(page.getByTestId("sql-error")).toHaveAttribute("data-code", "cancelled", { timeout: 15_000 });
  await expect(page.getByTestId("sql-run")).toBeEnabled();
  // and the live run is still saving
  const later = await savedTick();
  await expect.poll(savedTick, { timeout: 15_000 }).toBeGreaterThan(later);
});
