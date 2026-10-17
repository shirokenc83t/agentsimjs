import { expect, test } from "@playwright/test";
import { isSoftwareRenderer, RENDERER_PROBE, writeGpuRecord } from "../../../tools/test/gpu.ts";
import { sceneSettled, sendTo, waitForStorageReady } from "./helpers.ts";

/** Hardware-GPU run (`pnpm test:e2e:gpu`, ADR-0022): only there are the display-rate thresholds gated. */
const GPU = !!process.env["AGENTSIM_E2E_GPU"];
/** Agreed F1 thresholds (2026-10-04): close to the display rate on the maintainer's GPU; 25 fps stays a hard floor. */
const MIN_MEAN_FPS = 55;
const MAX_INTERVAL_P95_MS = 20;
const FLOOR_FPS = 25;
const SAMPLE_MS = 10_000;

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.95 * s.length) - 1))] ?? Number.NaN;
};

// F1 phase close: the real world (1 km² atlas), drawn paths and moving agents at display rate on a hardware GPU.
// On CI (software GL) the same numbers are reported, not gated.
test("display rate on the 1 km² reference world with paths and moving agents", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await page.getByTestId("run-label").click();
  await page.getByTestId("load-reference").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f1-reference-1km v\d+$/, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await sceneSettled(page);

  // Both agents get long routes, so they keep moving with planned and executed paths drawn for the whole sample.
  await sendTo(page, "uav-001", 200, 250);
  await sendTo(page, "ugv-001", 700, 700);
  await page.getByTestId("play").click();
  await page.waitForTimeout(2000); // plans found, both agents under way

  await page.evaluate(() => window.__agentsim && (window.__agentsim.frames.length = 0));
  await page.waitForTimeout(SAMPLE_MS);
  const frames = await page.evaluate(() => (window.__agentsim?.frames ?? []).map(([t]) => t));
  const status = await page.evaluate(() => ({
    rover: window.__agentsim?.scene?.paths("ugv-001"),
    scout: window.__agentsim?.scene?.paths("uav-001"),
  }));
  const intervals = frames.slice(1).map((t, i) => t - (frames[i] ?? t));
  const spanS = ((frames.at(-1) ?? 0) - (frames[0] ?? 0)) / 1000;
  const meanFps = spanS > 0 ? (frames.length - 1) / spanS : 0;
  const renderer = String(await page.evaluate(RENDERER_PROBE));
  const record = {
    scene: "f1-reference-1km: 2,000 x 2,000 cells (1 atlas page), scout flying, rover driving cross-map, paths drawn",
    sampleMs: SAMPLE_MS,
    frames: frames.length,
    meanFps: +meanFps.toFixed(1),
    frameIntervalP95Ms: +p95(intervals).toFixed(2),
    frameIntervalMaxMs: +Math.max(...intervals).toFixed(2),
    thresholds: { minMeanFps: MIN_MEAN_FPS, maxIntervalP95Ms: MAX_INTERVAL_P95_MS, floorFps: FLOOR_FPS },
    renderer,
    browser: `chromium ${browser.version()}`,
    platform: process.platform,
    gpuRun: GPU,
  };
  console.log(JSON.stringify(record));
  testInfo.annotations.push({ type: "fps", description: JSON.stringify(record) });

  // The scene really had moving agents with paths during the sample.
  expect(status.rover?.planned ?? 0).toBeGreaterThan(1);
  expect(status.rover?.executed ?? 0).toBeGreaterThan(1);
  expect(status.scout?.executed ?? 0).toBeGreaterThan(1);

  if (!GPU) return; // software GL in CI: reported, not gated (ADR-0022)
  // Evidence first, so a failing run still leaves its numbers for the report.
  writeGpuRecord("f1ReferenceWorld", record);
  expect(isSoftwareRenderer(renderer), `test:e2e:gpu needs a hardware GPU, got ${renderer}`).toBe(false);
  expect(meanFps, "hard floor").toBeGreaterThanOrEqual(FLOOR_FPS);
  expect(meanFps, "mean fps").toBeGreaterThanOrEqual(MIN_MEAN_FPS);
  expect(record.frameIntervalP95Ms, "frame-interval p95").toBeLessThanOrEqual(MAX_INTERVAL_P95_MS);
});
