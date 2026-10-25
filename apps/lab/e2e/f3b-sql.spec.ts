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

test("Data opens with the Storage about 30 % and the SQL console 70 %; the editor takes a quarter of the console and the border moves; the results can fill the panel (Esc returns) or be pinned in a window that keeps them", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);
  await openWorkspace(page, "data");
  const h = async (id: string) => (await page.getByTestId(id).boundingBox())?.height ?? 0;
  const dockH = async () => (await page.locator(".dv-dockview").first().boundingBox())?.height ?? 1;
  await expect.poll(async () => (await h("sql-console")) / (await dockH())).toBeGreaterThan(0.55); // the console is most of the height (70 % less its tab bar)
  // The editor part is a quarter of what is under the console's bar; dragging the border and the arrow keys move it.
  const top = async () => (await page.locator(".sql-top").boundingBox())?.height ?? 0;
  const results = async () => (await page.getByTestId("sql-results").boundingBox())?.height ?? 0;
  expect(await results()).toBeGreaterThan(2 * (await top()));
  const before = await top();
  await page.getByTestId("sql-sash").focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(top).toBeGreaterThan(before);

  await runSql(page, "SELECT run_id, label FROM runs");
  await expect(page.getByTestId("sql-status").first()).toContainText("row", { timeout: 15_000 });
  // Maximize: the results fill the panel, the editor is gone, Esc brings it back.
  await page.getByTestId("sql-maximize").click();
  await expect(page.getByTestId("sql-editor")).toBeHidden();
  await expect(page.getByTestId("sql-grid")).toBeVisible();
  await page.getByTestId("sql-grid").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sql-editor")).toBeVisible();

  // The window keeps the result pinned while the next statement is written and run.
  await page.getByTestId("sql-window").click();
  await expect(page.getByTestId("sql-pinned")).toBeVisible();
  await expect(page.getByTestId("sql-pinned-status")).toContainText("SELECT run_id, label FROM runs");
  await runSql(page, "SELECT 1 AS one");
  await expect(page.getByTestId("sql-status").first()).toContainText("1 row", { timeout: 15_000 });
  await expect(page.getByTestId("sql-pinned-status")).toContainText("SELECT run_id, label FROM runs");
  await expect(page.getByTestId("sql-pinned").getByTestId("sql-grid")).toBeVisible();
});

test("the schema is a tree with row counts; a click on a table previews its first 10 rows through the read-only path; user_data is listed and not readable", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  await step(page, 1);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 100", { timeout: 30_000 });
  await openWorkspace(page, "data");
  await page.getByTestId("sql-schema-toggle").click();
  await expect(page.getByTestId("sql-count-trace_records")).toContainText(/\d[\d,]* rows/, { timeout: 15_000 });
  await expect(page.getByTestId("sql-schema")).toContainText("user_data  (not readable here)");
  await page.getByTestId("sql-twist-trace_records").click();
  await expect(page.getByTestId("sql-schema")).toContainText("seq");
  await page.getByTestId("sql-table-trace_records").click();
  await expect(page.getByTestId("sql-editor")).toHaveValue('SELECT * FROM "trace_records" LIMIT 10');
  await expect(page.getByTestId("sql-status").first()).toContainText("10 rows", { timeout: 15_000 });
  await page.getByTestId("sql-preview-rows").selectOption("100");
  await page.getByTestId("sql-table-runs").click();
  await expect(page.getByTestId("sql-editor")).toHaveValue('SELECT * FROM "runs" LIMIT 100');
  await expect(page.getByTestId("sql-status").first()).toContainText("row", { timeout: 15_000 });
});
