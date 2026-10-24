import { expect, test, type Page } from "@playwright/test";
import { isSoftwareRenderer, RENDERER_PROBE, writeGpuRecord } from "../../../tools/test/gpu.ts";
import { openPanelTab, openWorkspace, referenceSettled, runCommand, sendTo, waitForStorageReady } from "./helpers.ts";

/** Hardware-GPU run (`pnpm test:e2e:gpu`, ADR-0022): only there are the display-rate thresholds gated. */
const GPU = !!process.env["AGENTSIM_E2E_GPU"];
/** The F1 bar (2026-10-04), kept for F2 (2026-10-12): close to the display rate; 25 fps stays a hard floor. */
const MIN_MEAN_FPS = 55;
const MAX_INTERVAL_P95_MS = 20;
const FLOOR_FPS = 25;
const SAMPLE_MS = 10_000;

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.95 * s.length) - 1))] ?? Number.NaN;
};


/**
 * A new run of the current scenario whose agents plan with an eager refine (HPA* coarse path, A* legs): a run's own planning
 * queries then carry stages, and the stages overlay of the viewed agent draws the latest of them.
 */
async function useRefineStrategy(page: Page) {
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Run configuration");
  const panel = page.getByTestId("run-config-panel");
  await panel.getByTestId("rc-planner").selectOption("strategy");
  await panel.getByTestId("rc-strategy-preset").selectOption("inline");
  await panel.getByTestId("rc-strategy-json").fill(
    JSON.stringify({ schemaVersion: 0, id: "stages", version: 1, origin: "human", root: { kind: "refine", mode: "eager", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } }),
  );
  await expect(panel.getByTestId("rc-valid")).toBeVisible();
  await panel.getByTestId("rc-run").click();
  await openWorkspace(page, "scene");
  await referenceSettled(page);
}

/** Samples the render loop for `SAMPLE_MS` and returns the frame statistics. */
async function sample(page: Page) {
  await page.evaluate(() => window.__agentsim && (window.__agentsim.frames.length = 0));
  await page.waitForTimeout(SAMPLE_MS);
  const frames = await page.evaluate(() => (window.__agentsim?.frames ?? []).map(([t]) => t));
  const intervals = frames.slice(1).map((t, i) => t - (frames[i] ?? t));
  const spanS = ((frames.at(-1) ?? 0) - (frames[0] ?? 0)) / 1000;
  return {
    frames: frames.length,
    meanFps: +(spanS > 0 ? (frames.length - 1) / spanS : 0).toFixed(1),
    frameIntervalP95Ms: +p95(intervals).toFixed(2),
    frameIntervalMaxMs: +Math.max(...intervals).toFixed(2),
  };
}

// F2 phase close: the 1 km² reference world with every overlay on (the viewed agent's belief map and, in the second sample,
// the researcher-only difference against the ground truth; its lidar rays; its regions and frontier groups) while agents
// move, at display rate on a hardware GPU. On CI (software GL) the numbers are reported, not gated.
test("display rate on the 1 km² reference world with belief, difference, rays and frontier overlays on", async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000);
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await runCommand(page, "Load F2 prior map demo");
  await page.getByTestId("run-label").click();
  await expect(page.getByTestId("run-scenario")).toHaveText(/^f2-prior-1km v\d+$/, { timeout: 90_000 });
  await page.keyboard.press("Escape");
  await referenceSettled(page);
  await useRefineStrategy(page);

  // The scout (airborne, unknown map) and the rover (known prior) both cross the map; the scout is the viewed agent, so its
  // map keeps growing under the overlay.
  // The target is picked by a click on the canvas (about 1.6 m a pixel), so one next to an obstacle makes the scout's goTo fail in a layout where the
  // click lands a pixel away: (200, 250) did, once the status line wrapped (the recording status), so the scout goes to (220, 250).
  await sendTo(page, "uav-001", 220, 250);
  await sendTo(page, "ugv-001", 700, 700);
  await page.getByTestId("explorer-row-uav-001").click();
  await page.getByTestId("overlay-belief").click();
  await page.getByTestId("overlay-rays").click();
  await page.getByTestId("overlay-frontiers").click();
  await expect
    .poll(() => page.evaluate(() => { const b = window.__agentsim?.scene?.stats().belief; return b !== undefined && b.pages === 1 && b.chunksPending === 0; }), { timeout: 120_000 })
    .toBe(true);
  await page.getByTestId("play").click();
  await page.waitForTimeout(2000); // plans found, both agents under way, overlays streaming

  const belief = await sample(page);
  await page.getByTestId("overlay-difference").click();
  await expect
    .poll(() => page.evaluate(() => { const b = window.__agentsim?.scene?.stats().belief; return b !== undefined && b.pages === 1 && b.chunksPending === 0; }), { timeout: 60_000 })
    .toBe(true);
  const difference = await sample(page);

  // F2b: the stages overlay joins them: a Strategy test of a refine for the scout (coarse path dashed, legs, numbered joints),
  // drawn by the overlay that draws a run's query stages, over the same scene, while both agents keep moving.
  await page.getByTestId("overlay-stages").click();
  // The run's own stages first: the scout's plan (an eager refine) is in the trace, and the overlay draws its coarse path and legs.
  await expect.poll(() => page.evaluate(() => window.__agentsim?.scene?.overlays().stages.legs), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.getByTestId("st-strategy").selectOption("inline");
  await page.getByTestId("st-json").fill(
    JSON.stringify({ schemaVersion: 0, id: "gpu", version: 1, origin: "human", root: { kind: "refine", mode: "eager", coarse: { kind: "algorithm", algorithm: "hpa" }, local: { kind: "algorithm", algorithm: "astar" } } }),
  );
  await page.getByTestId("st-x").fill("220");
  await page.getByTestId("st-y").fill("250");
  await page.getByTestId("st-run").click();
  await expect(page.getByTestId("st-status")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1000);
  const stages = await sample(page);
  const drawn = await page.evaluate(() => window.__agentsim?.scene?.overlays());

  const renderer = String(await page.evaluate(RENDERER_PROBE));
  const common = {
    scene: "f2-prior-1km: 2,000 x 2,000 cells (1 atlas page), scout flying and rover driving cross-map; the scout viewed with belief (then difference) + lidar rays + regions and frontier groups (+ both stages overlays for the third sample: the scout's latest refine query, drawn from its trace, and a Strategy test of a refine; the run's agents plan with an eager refine)",
    sampleMs: SAMPLE_MS,
    thresholds: { minMeanFps: MIN_MEAN_FPS, maxIntervalP95Ms: MAX_INTERVAL_P95_MS, floorFps: FLOOR_FPS },
    overlaysDrawn: drawn,
    renderer,
    browser: `chromium ${browser.version()}`,
    platform: process.platform,
    gpuRun: GPU,
  };
  console.log(JSON.stringify({ f2OverlaysBelief: { ...belief, ...common }, f2OverlaysDifference: { ...difference, ...common }, f2bOverlaysStages: { ...stages, ...common } }));
  testInfo.annotations.push({ type: "fps", description: JSON.stringify({ belief, difference, stages }) });

  // The overlays really were on and drawing during the samples.
  expect(drawn?.rays ?? 0).toBeGreaterThan(0);
  expect(drawn?.regions ?? 0).toBeGreaterThan(0);
  expect(drawn?.stages.legs ?? 0, "the stages overlay is drawing a run query's stages").toBeGreaterThan(0);
  expect(drawn?.stages.coarseDashes ?? 0, "…with its coarse path dashed").toBeGreaterThan(0);
  expect(drawn?.sandbox.legs ?? 0, "…and a Strategy test next to it").toBeGreaterThan(0);
  expect(drawn?.sandbox.coarseDashes ?? 0).toBeGreaterThan(0);

  if (!GPU) return; // software GL in CI: reported, not gated (ADR-0022)
  // Evidence first, so a failing run still leaves its numbers for the report.
  writeGpuRecord("f2OverlaysBelief", { ...belief, ...common });
  writeGpuRecord("f2OverlaysDifference", { ...difference, ...common });
  writeGpuRecord("f2bOverlaysStages", { ...stages, ...common });
  expect(isSoftwareRenderer(renderer), `test:e2e:gpu needs a hardware GPU, got ${renderer}`).toBe(false);
  for (const [name, r] of [["belief", belief], ["difference", difference], ["stages (with belief, difference, rays, frontiers)", stages]] as const) {
    expect(r.meanFps, `${name}: hard floor`).toBeGreaterThanOrEqual(FLOOR_FPS);
    expect(r.meanFps, `${name}: mean fps`).toBeGreaterThanOrEqual(MIN_MEAN_FPS);
    expect(r.frameIntervalP95Ms, `${name}: frame-interval p95`).toBeLessThanOrEqual(MAX_INTERVAL_P95_MS);
  }
});
