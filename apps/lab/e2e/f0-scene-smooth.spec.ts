import { expect, test, type Page } from "@playwright/test";
import { isSoftwareRenderer, RENDERER_PROBE, writeGpuRecord } from "../../../tools/test/gpu.ts";
import { DUMMY_POSE_FLOATS, writeDummyPoses } from "../src/sim/dummy-world.ts";

/** Hardware-GPU run (`pnpm test:e2e:gpu`, ADR-0022): only there is the display-rate assertion gated. */
const GPU = !!process.env["AGENTSIM_E2E_GPU"];
/** Float32 positions vs. recomputed tick positions: equal up to float error. */
const EPS_M = 1e-4;

/** x of the dummy entity at every tick up to `maxTick` (the dummy path is a pure function of the tick). */
function tickXs(maxTick: number): Float64Array {
  const pose = new Float32Array(DUMMY_POSE_FLOATS);
  const xs = new Float64Array(maxTick + 1);
  for (let t = 0; t <= maxTick; t++) {
    writeDummyPoses(t, pose);
    xs[t] = pose[0] ?? Number.NaN;
  }
  return xs;
}

const onTick = (x: number, xs: Float64Array) => xs.some((v) => Math.abs(v - x) <= EPS_M);

async function sample(page: Page, ms: number) {
  await page.evaluate(() => (window.__agentsim ? (window.__agentsim.frames.length = 0) : undefined));
  await page.waitForTimeout(ms);
  return page.evaluate(() => ({ frames: window.__agentsim?.frames ?? [], tick: (window.__agentsim?.sim() as { tick: number }).tick }));
}

const fpsOf = (frames: [number, number][]) => frames.length / (((frames.at(-1)?.[0] ?? 0) - (frames[0]?.[0] ?? 0)) / 1000);

async function setSpeed(page: Page, hz: number) {
  await page.getByRole("combobox", { name: "Speed" }).selectOption(String(hz));
  await page.waitForTimeout(1000); // let the interval estimate converge after the change
}

// F0 acceptance: a dummy entity moved by the sim worker renders smoothly at display rate while the worker
// ticks at a lower fixed rate. Interpolation is checked independently of the frame rate (works on
// software GL); the display rate itself is gated only on a hardware GPU (ADR-0022).
test("interpolation: rendered positions fall between tick positions", async ({ page }) => {
  await page.goto("/?probe");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  // 5 Hz keeps several frames per tick even on slow software rendering.
  await setSpeed(page, 5);
  const { frames, tick } = await sample(page, 4000);
  const xs = tickXs(tick + 2);
  const between = frames.filter(([, x]) => !onTick(x, xs)).length;
  console.log(JSON.stringify({ frames: frames.length, fps: +fpsOf(frames).toFixed(1), betweenTicks: between }));
  expect(frames.length).toBeGreaterThan(20);
  expect(between / frames.length).toBeGreaterThan(0.6);
});

test("without interpolation every rendered position is a tick position", async ({ page }) => {
  await page.goto("/?probe");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  await setSpeed(page, 5);
  await page.getByTestId("hud-interpolation").uncheck();
  const { frames, tick } = await sample(page, 3000);
  const xs = tickXs(tick + 2);
  const off = frames.filter(([, x]) => !onTick(x, xs));
  expect(frames.length).toBeGreaterThan(10);
  expect(off, "positions not matching any tick").toEqual([]);
});

test("display rate: the scene renders well above the sim tick rate", async ({ page, browser }, testInfo) => {
  await page.goto("/?probe");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  await expect(page.getByTestId("hud-tick-rate")).toHaveText(/^(9|10|11)\.\d\/s \(target 10 Hz\)/, { timeout: 10_000 });
  const { frames } = await sample(page, 3000);
  const fps = fpsOf(frames);
  const renderer = String(await page.evaluate(RENDERER_PROBE));
  const record = { fps: +fps.toFixed(1), tickRateHz: 10, renderer, browser: `chromium ${browser.version()}`, platform: process.platform, gpuRun: GPU };
  console.log(JSON.stringify(record));
  testInfo.annotations.push({ type: "fps", description: JSON.stringify(record) });
  if (!GPU) return; // software GL in CI: reported, not gated (ADR-0022)
  expect(isSoftwareRenderer(renderer), `test:e2e:gpu needs a hardware GPU, got ${renderer}`).toBe(false);
  expect(fps).toBeGreaterThan(25);

  writeGpuRecord("f0DummyScene", record);
});

test("run controls pause, step and resume the sim worker from the toolbar", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("pause").click();
  const tickText = async () => Number((await page.getByTestId("status-tick").textContent())?.replace(/\D/g, ""));
  await page.waitForTimeout(300);
  const t0 = await tickText();
  await page.waitForTimeout(600);
  expect(await tickText()).toBe(t0);
  await page.getByTestId("step").click();
  await expect.poll(tickText).toBe(t0 + 1);
  await page.getByTestId("play").click();
  await expect.poll(tickText).toBeGreaterThan(t0 + 3);
});
