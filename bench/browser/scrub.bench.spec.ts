import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { recordRenderer, recordResults, summarize } from "../../tools/bench/measure.ts";
import { RENDERER_PROBE } from "../../tools/test/gpu.ts";
import { openWorkspace, runCommand, waitForStorageReady } from "../../apps/lab/e2e/helpers.ts";

// F3a M3 measurements (ADR-0035 addition of 2026-10-17, items 9 and 12; plan F3 acceptance 3): a recorded run scrubbed from storage with the belief overlay on.
// `render.scrub10min`: the frame work while the cursor is dragged over a 10-minute recording (budget: p95 ≤ 4 ms locally), and the time from a cursor that has
// moved to the first updated overlay (budget: ≤ 200 ms). The same on the 1 km² world. Report only until Max confirms the entries of bench/thresholds.json.

/** These take minutes (a 10-minute run is recorded first): they run only with AGENTSIM_BENCH_SCRUB=1. */
const RUN = !!process.env["AGENTSIM_BENCH_SCRUB"];

function emit(text: string): void {
  mkdirSync("bench/results", { recursive: true });
  appendFileSync("bench/results/scrub-tables.md", `${text}\n`);
  console.log(text);
}

test.skip(!RUN, "AGENTSIM_BENCH_SCRUB is not set");

/** Drives the replay slider like a hand: sets its value and fires the input event React listens to. */
async function installDriver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __setCursor: (v: number) => void; __overlayChecksum: (size: number, step: number) => number };
    w.__setCursor = (v) => {
      const input = document.querySelector('[data-testid="replay-cursor"]') as HTMLInputElement | null;
      if (!input) throw new Error("no replay slider");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    w.__overlayChecksum = (size, step) => {
      let h = 17;
      for (let j = 0; j < size; j += step) for (let i = 0; i < size; i += step) h = (h * 31 + (window.__agentsim?.scene?.beliefCell(i, j) ?? 9)) | 0;
      return h;
    };
  });
}

async function headOf(page: Page): Promise<number> {
  return Number(/\/ ([\d.]+) s/.exec((await page.getByTestId("replay-time").textContent()) ?? "")?.[1]);
}

/** Frame work while the cursor is dragged back and forth over the recording for `seconds`, at about 30 moves a second. */
async function dragFrameWork(page: Page, head: number, seconds: number): Promise<number[]> {
  await page.evaluate(() => {
    const p = window.__agentsim;
    if (p) p.frameLog.length = 0;
  });
  await page.evaluate(
    ([headS, ms]) =>
      new Promise<void>((resolve) => {
        const w = window as unknown as { __setCursor: (v: number) => void };
        const t0 = performance.now();
        const timer = setInterval(() => {
          const e = performance.now() - t0;
          w.__setCursor(Math.round((headS * (0.5 + 0.45 * Math.sin(e / 900))) * 10) / 10);
          if (e > (ms ?? 0)) {
            clearInterval(timer);
            resolve();
          }
        }, 33);
      }),
    [head, seconds * 1000] as const,
  );
  return page.evaluate(() => (window.__agentsim?.frameLog ?? []).map((f) => f[1]));
}

/** From a cursor that moved to the first overlay that differs from the one shown, in ms (the cursor is set in the page, the clock starts there). */
async function firstOverlayMs(page: Page, to: number, size: number, step: number): Promise<number> {
  return page.evaluate(
    ([t, s, st]) =>
      new Promise<number>((resolve) => {
        const w = window as unknown as { __setCursor: (v: number) => void; __overlayChecksum: (size: number, step: number) => number };
        // The overlay has changed when a sampled cell differs or the atlas took in chunks (on a 1 km² map a sparse sample can miss a change).
        const uploaded = () => window.__agentsim?.scene?.stats().belief.chunksUploaded ?? 0;
        const before = w.__overlayChecksum(s ?? 0, st ?? 1);
        const uploadedBefore = uploaded();
        const t0 = performance.now();
        w.__setCursor(t ?? 0);
        const poll = () => {
          if (w.__overlayChecksum(s ?? 0, st ?? 1) !== before || uploaded() !== uploadedBefore) resolve(performance.now() - t0);
          else if (performance.now() - t0 > 5000) resolve(Number.NaN);
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }),
    [to, size, step] as const,
  );
}

async function scrubBench(page: Page, label: "scrub10min" | "scrub1km", original: string, agent: string, size: number, step: number): Promise<void> {
  await openWorkspace(page, "data");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByTestId(`replay-${original}`).click();
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("replay-label")).toContainText(original, { timeout: 60_000 });
  await page.getByTestId(`explorer-row-${agent}`).click();
  await page.getByTestId("overlay-belief").click();
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.stats().belief.pages), { timeout: 60_000 }).toBe(1);
  await installDriver(page);
  const head = await headOf(page);
  expect(head).toBeGreaterThan(10);
  const renderer = String(await page.evaluate(RENDERER_PROBE));
  recordRenderer(renderer);
  // Warm: the first reads fill the keyframe cache.
  await page.evaluate((v) => (window as unknown as { __setCursor: (v: number) => void }).__setCursor(v), head * 0.5);
  await page.waitForTimeout(2000);

  const work = await dragFrameWork(page, head, 12);
  expect(work.length).toBeGreaterThan(30);
  const firsts: number[] = [];
  for (const f of [0.3, 0.9, 0.5, 0.95, 0.2, 0.7, 0.4, 0.85, 0.6, 0.15]) {
    await page.waitForTimeout(1200); // the previous overlay has settled
    const ms = await firstOverlayMs(page, Math.round(head * f * 10) / 10, size, step);
    if (!Number.isNaN(ms)) firsts.push(ms);
  }
  expect(firsts.length).toBeGreaterThan(3);
  const w = summarize(work);
  const o = summarize(firsts);
  emit(
    `\n${label}: recording of ${head.toFixed(0)} s, belief overlay of ${agent} on, ${renderer}\n` +
      `  frame work while the cursor is dragged (${work.length} frames): mean ${w.mean.toFixed(2)} ms, median ${(w.median ?? Number.NaN).toFixed(2)} ms, p95 ${w.p95.toFixed(2)} ms (budget p95 ≤ 4 ms locally)\n` +
      `  cursor moved to first updated overlay (${firsts.length} jumps): median ${(o.median ?? Number.NaN).toFixed(0)} ms, p95 ${o.p95.toFixed(0)} ms, max ${Math.max(...firsts).toFixed(0)} ms (budget ≤ 200 ms)`,
  );
  recordResults("browser.json", { [`render.${label}`]: w, [`render.${label}.firstOverlay`]: o });
}

async function startRun(page: Page, command: string, scenario: RegExp, agent: string): Promise<string> {
  await runCommand(page, command);
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(scenario, { timeout: 60_000 });
  const id = (await page.getByTestId("run-id").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await page.getByTestId(`explorer-row-${agent}`).click();
  await runCommand(page, `Explore selected agent (${agent})`);
  return id;
}

async function stepTicks(page: Page, hundreds: number, timeoutMs: number): Promise<void> {
  const start = await page.evaluate(() => (window.__agentsim?.sim() as { tick: number }).tick);
  for (let k = 1; k <= hundreds; k++) {
    await runCommand(page, "Step 100 ticks");
    await expect(page.getByTestId("status-tick")).toHaveText(`tick ${start + k * 100}`, { timeout: timeoutMs });
  }
  await expect(page.getByTestId("status-recording-saved")).toHaveText(`saved to tick ${start + hundreds * 100}`, { timeout: 120_000 });
}

test("scrub: a 10-minute recording with the belief overlay on", async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  const original = await startRun(page, "Load F2 discovery demo", /^f2-discovery v\d+$/, "ugv-001");
  await stepTicks(page, 60, 60_000); // 6,000 ticks: 10 minutes of sim time
  await runCommand(page, "Load F2 discovery demo"); // another run: the first is a recording like any other
  await page.waitForTimeout(1500);
  await scrubBench(page, "scrub10min", original, "ugv-001", 128, 4);
});

test("scrub: the belief overlay of a recording of the 1 km² world", async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  const original = await startRun(page, "Load F2 prior map demo", /^f2-prior-1km v\d+$/, "ugv-001");
  await stepTicks(page, 6, 120_000); // 600 ticks (1 minute) of a 1 km² world
  await runCommand(page, "Load F2 discovery demo");
  await page.waitForTimeout(1500);
  await scrubBench(page, "scrub1km", original, "ugv-001", 2000, 32);
});
