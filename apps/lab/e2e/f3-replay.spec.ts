import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { countSimMessages, loadF2, openWorkspace, runCommand, setReplayCursor, simMessages, step, waitForStorageReady } from "./helpers.ts";

// F3a M3 (acceptance 1): record a run, export it (JSON lines and per-run SQLite), delete it, reload the page, import the files: each is added as a new run
// with a fresh ID (the deleted ID is not reused) and replays as the same run: the same Inspector state at moments of the run, the same events and the same
// checkpoint hash. The sim worker receives no run message while the imported runs are replayed.

const AGENT = "ugv-001";
const FORBIDDEN = ["load", "control", "command", "buildPreset", "strategyTest", "step"];

async function downloadOf(page: Page, click: () => Promise<void>, to: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent("download"), click()]);
  await download.saveAs(to);
  return to;
}

/** What replaying `runId` shows: the rover's state at two moments, the first events of the run, and the first checkpoint record. */
async function signature(page: Page, runId: string) {
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByTestId(`replay-${runId}`).click();
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("replay-label")).toContainText(runId, { timeout: 30_000 });
  const out: Record<string, string> = {};
  const head = Number(/\/ ([\d.]+) s/.exec((await page.getByTestId("replay-time").textContent()) ?? "")?.[1]);
  for (const t of [5, head]) {
    await setReplayCursor(page, t);
    await page.getByTestId(`explorer-row-${AGENT}`).click();
    await expect(page.getByTestId("inspector-state")).toContainText("position");
    // The panel is polled: wait until it shows the cursor's moment (its odometer settles), then read.
    await page.waitForTimeout(400);
    out[`state@${t}`] = (await page.getByTestId("inspector-state").textContent()) ?? "";
  }
  await openWorkspace(page, "debug");
  await page.getByTestId("event-kind-event").click({ modifiers: ["Shift"] }); // that kind alone
  await expect.poll(() => page.locator('[data-testid^="event-row-"]').count(), { timeout: 15_000 }).toBeGreaterThan(2);
  const rows = page.locator('[data-testid^="event-row-"]');
  // The list reloads while the live run goes on in the background: read it until a read finds the rows.
  await expect
    .poll(async () => (out["events"] = (await rows.evaluateAll((els) => els.slice(0, 12).map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()))).join(" | ")), { timeout: 15_000 })
    .not.toBe("");
  const checkpoint = rows.filter({ hasText: "checkpoint" }).first();
  await checkpoint.click();
  out["checkpoint"] = ((await page.getByTestId("event-detail").textContent()) ?? "").replace(/"id": "run-\d{6}#/g, '"id": "run-X#').replace(/"runId": "run-\d{6}"/g, '"runId": "run-X"');
  expect(out["checkpoint"]).toContain("stateHash");
  return out;
}

test("a run exported as JSON lines or as a per-run SQLite file and added to the database again replays as the same run", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await countSimMessages(page);
  await loadF2(page, "discovery");
  await page.getByTestId("run-label").click();
  const original = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 4);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 400", { timeout: 20_000 });
  // A second run starts, so the first is no longer the one being recorded (it can be deleted).
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("run-id")).not.toHaveText(original);
  await page.keyboard.press("Escape");

  // The original, replayed: what the imported runs must show.
  const before = await signature(page, original);

  // Export it twice.
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  const jsonlPath = await downloadOf(page, () => page.getByTestId(`export-jsonl-${original}`).click(), testInfo.outputPath("run.agentsim.jsonl"));
  const sqlitePath = await downloadOf(page, () => page.getByRole("button", { name: `Export ${original}`, exact: true }).click(), testInfo.outputPath("run.sqlite"));
  expect(readFileSync(jsonlPath, "utf8").split("\n")[0]).toContain('"format":"agentsim-run-jsonl"');

  // Delete it (its ID is kept: never reused), reload, import the files.
  await page.getByRole("button", { name: `Delete ${original}`, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByTestId(`run-row-${original}`)).toHaveCount(0);
  await page.reload();
  await waitForStorageReady(page);
  await openWorkspace(page, "data");

  await page.getByTestId("import-run-file").setInputFiles(jsonlPath);
  await expect(page.getByTestId("storage-message")).toContainText(`(it was ${original})`);
  const idOf = async () => /as (run-\d{6}) \(it was/.exec((await page.getByTestId("storage-message").textContent()) ?? "")?.[1] ?? "";
  const fromJsonl = await idOf();
  expect(fromJsonl).toMatch(/^run-\d{6}$/);
  expect(fromJsonl).not.toBe(original);
  await page.getByTestId("import-run-file").setInputFiles(sqlitePath);
  await expect(page.getByTestId("storage-message")).not.toContainText(fromJsonl, { timeout: 15_000 });
  const fromSqlite = await idOf();
  expect(fromSqlite).not.toBe(fromJsonl);
  expect(fromSqlite).not.toBe(original);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId(`run-row-${fromJsonl}`)).toBeVisible();
  await expect(page.getByTestId(`run-row-${fromSqlite}`)).toBeVisible();

  // Each replays as the same run, and the sim worker is not asked to run anything.
  const mark = (await simMessages(page)).length;
  for (const id of [fromJsonl, fromSqlite]) {
    const after = await signature(page, id);
    expect(after, `${id} replays as ${original}`).toEqual(before);
  }
  const during = (await simMessages(page)).slice(mark);
  expect(during.filter((t) => FORBIDDEN.includes(t)), `messages to the sim worker during the replays: ${during.join(", ")}`).toEqual([]);
});
