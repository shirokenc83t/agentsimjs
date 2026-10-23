import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadF2, openWorkspace, runCommand, step } from "./helpers.ts";

// F3b M3 (UI-SPEC section 4): the trace tree around a record picked in the log: its parents, what it was caused by, its children and effects. No component of the simulator writes
// `parentId` or `causeIds` yet (the schema and the storage have them), so the run here is a real recording whose records are given the relations the action runtime will
// state (a phase change is a child of its action's start and is caused by the phase change before it), exported and added to the database again as a run of its own.

const AGENT = "ugv-001";

interface Line {
  t?: string;
  v?: { id: string; kind: string; parentId?: string; causeIds?: string[]; payload?: { op?: string; actionId?: string } };
}

/** A recording as a run file, with the relations an action's records have. */
async function relatedRunFile(page: Page): Promise<Buffer> {
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-jsonl-run-000001").click()]);
  const lines = readFileSync(await download.path(), "utf8").split("\n").filter((l) => l !== "");
  const parsed = lines.map((l) => JSON.parse(l) as Line);
  const startOf = new Map<string, string>();
  for (const l of parsed) {
    const r = l.t === "record" ? l.v : undefined;
    if (r?.kind === "action" && r.payload?.op === "start" && r.payload.actionId !== undefined) startOf.set(r.payload.actionId, r.id);
  }
  let related = 0;
  const lastPhase = new Map<string, string>();
  for (const l of parsed) {
    const r = l.t === "record" ? l.v : undefined;
    if (r?.kind !== "action" || r.payload?.op !== "phase" || r.payload.actionId === undefined) continue;
    const start = startOf.get(r.payload.actionId);
    if (start === undefined) continue;
    r.parentId = start;
    const before = lastPhase.get(r.payload.actionId);
    if (before !== undefined) r.causeIds = [before];
    lastPhase.set(r.payload.actionId, r.id);
    related++;
  }
  expect(related, "the recording has phase changes of an action").toBeGreaterThan(4);
  return Buffer.from(`${parsed.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

test("the trace tree shows what a record was caused by and what came of it; a click on a node picks that record, and the log and the cursor follow", async ({ page }) => {
  test.setTimeout(240_000);
  await loadF2(page, "discovery");
  await page.getByTestId(`explorer-row-${AGENT}`).click();
  await runCommand(page, `Explore selected agent (${AGENT})`);
  await step(page, 3);
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 300", { timeout: 20_000 });

  // The related run is added to the database as a run of its own and opened for replay.
  const file = await relatedRunFile(page);
  await page.getByTestId("import-run-file").setInputFiles({ name: "related.jsonl", mimeType: "application/x-ndjson", buffer: file });
  await expect(page.getByTestId("run-row-run-000002")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("replay-run-000002").click();
  await expect(page.getByTestId("replay-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("workspace-debug")).toBeVisible();

  // The Trace is a tab of the Inspector's group, behind it: one click (here, its palette command) brings it forward.
  await expect(page.getByTestId("trace-tree")).toBeHidden();
  await runCommand(page, "Open panel: Trace");
  const empty = page.getByTestId("trace-tree-empty");
  await expect(empty).toBeVisible();
  // A phase change of an action: the log lists it; the tree shows the action's start as its parent and the phase change before it as its cause.
  await page.getByTestId("log-filter").fill(`kind:action agent:${AGENT} text:phase`);
  await expect.poll(async () => Number(await page.getByTestId("event-scroller").getAttribute("data-count")), { timeout: 15_000 }).toBeGreaterThan(4);
  await expect(page.locator('[data-testid^="event-row-"]:not([data-kind="action"])')).toHaveCount(0);
  const rows = page.locator('[data-testid^="event-row-"]');
  await rows.nth(3).click();
  await expect(empty).toHaveCount(0);
  const selected = page.getByTestId("trace-tree-selected");
  await expect(selected).toBeVisible();
  const phaseSeq = Number(await selected.getAttribute("data-seq"));
  await expect(page.getByTestId("tt-parents")).toContainText("start");
  const cause = page.getByTestId("tt-causes").locator('[data-testid^="trace-node-"]').first();
  await expect(cause).toContainText("phase");
  const causeSeq = Number(await cause.getAttribute("data-seq"));
  expect(causeSeq).toBeLessThan(phaseSeq);
  // A click on the cause picks it: the tree is drawn around it and shows the first record among its effects.
  await cause.click();
  await expect(selected).toHaveAttribute("data-seq", String(causeSeq));
  await expect(page.getByTestId("tt-effects").locator(`[data-seq="${phaseSeq}"]`)).toBeVisible();
  // The log follows the pick: its selected row is that record, and the shared cursor is at its moment.
  await expect(page.locator(`[data-testid="event-row-${causeSeq}"][aria-selected="true"]`)).toBeVisible({ timeout: 10_000 });
  const t = Number(((await page.getByTestId(`event-row-${causeSeq}`).textContent()) ?? "").split(" s")[0]);
  await expect(page.getByTestId("replay-time")).toContainText(`${t.toFixed(1)} s /`);
});
