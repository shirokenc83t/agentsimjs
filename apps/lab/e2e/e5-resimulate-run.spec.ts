import { expect, test, type Page } from "@playwright/test";
import { loadDemo, sendTo, step, waitForStorageReady } from "./helpers.ts";

/** State hash after the last step (paused, so the stats carry the hash of the current tick). */
async function hashAt(page: Page, tick: number): Promise<string> {
  await expect.poll(() => page.evaluate(() => (window.__agentsim?.sim() as { hashTick?: number }).hashTick)).toBe(tick);
  return page.evaluate(() => (window.__agentsim?.sim() as { stateHash: string }).stateHash);
}

/**
 * The run's trace without what legitimately differs between two runs: the run ID, the informational wall time,
 * and the run prefix of record IDs (`run-000001#7` → `#7`, also in `parentId` and `causeIds`). The snapshot and checkpoint records the
 * recording adds are left out: a re-simulation schedules its inputs before its first tick, so its start snapshot is not the live run's.
 */
async function traceOf(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const local = (id: unknown) => (typeof id === "string" ? id.replace(/^[^#]*#/, "#") : id);
    const recorded = (r: unknown) => (r as { kind?: string }).kind === "snapshot" || (r as { payload?: { op?: string } }).payload?.op === "checkpoint";
    return (window.__agentsim?.records?.() ?? []).filter((r) => !recorded(r)).map((r) => {
      const { runId: _r, wallTime: _w, id, parentId, causeIds, ...rest } = r as Record<string, unknown>;
      return {
        ...rest,
        id: local(id),
        ...(parentId === undefined ? {} : { parentId: local(parentId) }),
        ...(Array.isArray(causeIds) ? { causeIds: causeIds.map(local) } : {}),
      };
    });
  });
}

async function openRun(page: Page) {
  await page.getByTestId("run-label").click();
  await expect(page.getByRole("dialog", { name: "Run" })).toBeVisible();
}

// Run inputs are stored with the run (ADR-0015 clarification): a run reloaded after a browser restart
// re-simulates identically, because its scenario version, run configuration and recorded inputs are all in storage.
test("a run with two \"send to\" commands is re-simulated from storage after a reload: same hash at every checkpoint, identical trace", async ({ page }) => {
  test.setTimeout(90_000);
  await loadDemo(page);
  await openRun(page);
  const runId = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");

  const live: string[] = [];
  await sendTo(page, "ugv-001", 50, 10);
  await step(page, 1);
  live.push(await hashAt(page, 100));
  await sendTo(page, "ugv-002", 25, 30);
  await step(page, 1);
  live.push(await hashAt(page, 200));
  await step(page, 1);
  live.push(await hashAt(page, 300));
  const liveTrace = await traceOf(page);

  // Both inputs reached storage before the "browser restart".
  await openRun(page);
  await expect(page.getByTestId(`stored-run-inputs-${runId}`)).toHaveText("2 inputs");
  await page.keyboard.press("Escape");

  await page.reload();
  await waitForStorageReady(page);
  await openRun(page);
  await page.getByTestId(`resimulate-${runId}`).click();
  await expect(page.getByTestId("run-id")).not.toHaveText(runId);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-tick")).toHaveText("tick 0");

  const resimulated: string[] = [];
  for (const tick of [100, 200, 300]) {
    await step(page, 1);
    resimulated.push(await hashAt(page, tick));
  }
  expect(resimulated).toEqual(live);
  expect(new Set(live).size).toBe(3);
  // The trace is identical too, injected records included (only the run ID and the informational wall time differ).
  const resimTrace = await traceOf(page);
  expect(resimTrace.length).toBeGreaterThan(0);
  expect(resimTrace.filter((r) => (r as { kind?: string }).kind === "injected")).toHaveLength(2);
  expect(resimTrace).toEqual(liveTrace);

  // The re-simulation is a run of its own, with the same inputs stored for it.
  await openRun(page);
  const resimId = (await page.getByTestId("run-id").textContent()) ?? "";
  await expect(page.getByTestId(`stored-run-inputs-${resimId}`)).toHaveText("2 inputs");
});
