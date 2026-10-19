import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { recordResults, summarize } from "../../tools/bench/measure.ts";
import { openWorkspace, runCommand, waitForStorageReady } from "../../apps/lab/e2e/helpers.ts";

// F3a M2 measurements in the browser (ADR-0035 addition of 2026-10-17, items 8, 9 and 12): the persisted head's gap behind the sim head and the
// flush interval with the real storage worker, and the wall time of deleting a long recorded run while another run records. Report only.

/** These measurements take minutes and write hundreds of MB: they run only with AGENTSIM_BENCH_RECORDING=1 (report only, until K, S and the budgets are decided). */
const RUN = !!process.env["AGENTSIM_BENCH_RECORDING"];

function emit(text: string): void {
  mkdirSync("bench/results", { recursive: true });
  appendFileSync("bench/results/recording-tables.md", `${text}\n`);
  console.log(text);
}

async function loadTwentyAgents(page: Page): Promise<string[]> {
  await runCommand(page, "Load F2 20 agents demo");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f2-20-agents v\d+$/, { timeout: 60_000 });
  const runId = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  const ids = await page.evaluate(() => ((window.__agentsim?.sim() as { entityIds?: string[] } | undefined)?.entityIds ?? []).slice());
  expect(ids.length).toBe(20);
  void runId;
  return ids;
}

async function exploreAll(page: Page, ids: string[]): Promise<void> {
  for (const id of ids.filter((x) => x.startsWith("ugv"))) {
    await page.getByTestId(`explorer-row-${id}`).click();
    await runCommand(page, `Explore selected agent (${id})`);
  }
}

const speed = (page: Page, hz: number) => page.getByRole("combobox", { name: "Speed" }).selectOption(String(hz));

test.skip(!RUN, "AGENTSIM_BENCH_RECORDING is not set");

test("recording: the gap of the persisted head behind the sim head, and the flush interval, with 20 agents exploring", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  const ids = await loadTwentyAgents(page);
  await exploreAll(page, ids);
  const rows: (string | number)[][] = [["speed", "ticks / s", "gap p50 (ticks)", "gap p95 (ticks)", "gap p95 (sim s)", "gap p95 (wall ms)", "flush interval p50 (ms)", "flush interval p95 (ms)", "backpressure seen"]];
  for (const hz of [10, 20, 40]) {
    await speed(page, hz);
    await page.getByTestId("play").click();
    await page.waitForTimeout(2000);
    // Sample every 50 ms for 20 s inside the page: the sim tick, and the tick the status line says is saved.
    const samples = await page.evaluate(
      () =>
        new Promise<{ t: number; tick: number; saved: number; waiting: boolean }[]>((resolve) => {
          const out: { t: number; tick: number; saved: number; waiting: boolean }[] = [];
          const timer = setInterval(() => {
            const sim = window.__agentsim?.sim() as { tick: number } | undefined;
            const text = document.querySelector('[data-testid="status-recording-saved"]')?.textContent ?? "";
            const m = /saved to tick (\d+)/.exec(text);
            out.push({ t: performance.now(), tick: sim?.tick ?? 0, saved: m ? Number(m[1]) : -1, waiting: document.querySelector('[data-testid="status-recording-state"]') !== null });
          }, 50);
          setTimeout(() => {
            clearInterval(timer);
            resolve(out);
          }, 20_000);
        }),
    );
    await page.getByTestId("pause").click();
    const valid = samples.filter((s) => s.saved >= 0);
    const gaps = valid.map((s) => s.tick - s.saved);
    const span = ((samples.at(-1)?.tick ?? 0) - (samples[0]?.tick ?? 0)) / (((samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0)) / 1000);
    const changes: number[] = [];
    for (let i = 1; i < valid.length; i++) if ((valid[i]?.saved ?? 0) !== (valid[i - 1]?.saved ?? 0)) changes.push((valid[i]?.t ?? 0) - (valid[i - 1]?.t ?? 0) + 0);
    // Intervals between head updates: the time from one change to the next.
    const stamps = valid.filter((s, i) => i > 0 && s.saved !== (valid[i - 1]?.saved ?? 0)).map((s) => s.t);
    const intervals = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
    const g = summarize(gaps, "count");
    const iv = summarize(intervals);
    const wallP95 = (g.p95 / Math.max(0.1, span)) * 1000;
    rows.push([`${hz / 10}×`, span.toFixed(1), g.median, g.p95, (g.p95 * 0.1).toFixed(1), Math.round(wallP95), Math.round(iv.median), Math.round(iv.p95), samples.some((s) => s.waiting) ? "yes" : "no"]);
    recordResults("browser.json", { [`recording.gap.${hz}Hz`]: g, [`recording.flushInterval.${hz}Hz`]: iv });
    void changes;
  }
  emit(`\nPersisted head behind the sim head, 20 agents exploring (F2 20 agents), sampled every 50 ms for 20 s per speed, headless Chromium, OPFS:\n${rows.map((r) => r.join(" | ")).join("\n")}`);
});

test("recording: delete and VACUUM wall time on a long recorded 20-agent run while another run records", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  // A long recorded run: 20 agents exploring, 2,400 ticks (4 minutes of sim time), every step saved before the next.
  const idsA = await loadTwentyAgents(page);
  await page.getByTestId("run-label").click();
  const runA = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await exploreAll(page, idsA);
  const T0 = Date.now();
  for (let k = 0; k < 24; k++) {
    await runCommand(page, "Step 100 ticks");
    await expect(page.getByTestId("status-tick")).toHaveText(`tick ${(k + 1) * 100}`, { timeout: 120_000 });
  }
  await expect(page.getByTestId("status-recording-saved")).toHaveText("saved to tick 2400", { timeout: 120_000 });
  const recordedInMs = Date.now() - T0;
  const sizeBefore = (await page.getByTestId("status-storage-size").textContent()) ?? "";
  // Another run records while the old one is deleted.
  const idsB = await loadTwentyAgents(page);
  await exploreAll(page, idsB);
  await page.getByTestId("play").click();
  await page.waitForTimeout(3000);
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: `Delete ${runA}` }).click();
  const tickBefore = await page.evaluate(() => (window.__agentsim?.sim() as { tick: number }).tick);
  const t0 = Date.now();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete the run" }).click();
  await expect(page.getByTestId("storage-message")).toContainText(`deleted ${runA}`, { timeout: 300_000 });
  const deleteMs = Date.now() - t0;
  const tickAfter = await page.evaluate(() => (window.__agentsim?.sim() as { tick: number }).tick);
  const waited = await page.evaluate(() => document.querySelector('[data-testid="status-recording-state"]')?.textContent ?? "");
  await page.waitForTimeout(1500);
  const sizeAfter = (await page.getByTestId("status-storage-size").textContent()) ?? "";
  emit(
    `\nDelete + VACUUM of ${runA} (20 agents exploring, 2,400 ticks, recorded in ${(recordedInMs / 1000).toFixed(0)} s) while another 20-agent run records at 1×:\n` +
      `  database before: ${sizeBefore}\n  database after:  ${sizeAfter}\n  delete wall time: ${deleteMs} ms (the click to the message)\n` +
      `  sim ticks during the delete: ${tickAfter - tickBefore} (at 10 ticks/s: ${Math.round((deleteMs / 1000) * 10)} expected without a stall)\n  status line during the delete: ${waited || "no wait state shown at the end"}`,
  );
  recordResults("browser.json", { "recording.deleteVacuum": summarize([deleteMs]) });
});
