import { defineConfig, devices } from "@playwright/test";
import { gpuLaunchArgs } from "./tools/test/gpu.ts";

const PORT = 4173;
const VISUAL = /[\\/]visual[\\/].*\.spec\.ts$/;

// e2e runs against the production build served by `vite preview` with the strict CSP (ADR-0021).
export default defineConfig({
  testDir: "apps/lab/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  // A JSON report of every run (which test failed, with its error and attachments) is always written, so a failure is
  // captured even when nobody watched it: `playwright-report/e2e-report.json`.
  reporter: process.env["CI"]
    ? [["list"], ["html", { open: "never" }], ["json", { outputFile: "playwright-report/e2e-report.json" }]]
    : [["list"], ["json", { outputFile: "playwright-report/e2e-report.json" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    acceptDownloads: true,
    // `pnpm test:e2e:gpu` (ADR-0022): hardware GPU; display-rate assertions are gated only there.
    launchOptions: { args: gpuLaunchArgs(!!process.env["AGENTSIM_E2E_GPU"]) },
    // A failure keeps its trace, a screenshot and a video (in test-results/), whatever the machine.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Visual regression (ADR-0032 §9) is its own project: `pnpm test:visual`, run only on the pinned Playwright
  // image (CI job and the manual baseline update); `pnpm test:e2e` runs the functional specs only.
  projects: [
    { name: "e2e", testIgnore: VISUAL },
    { name: "visual", testMatch: VISUAL, use: { viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 } },
  ],
  // AGENTSIM_VISUAL_SNAPSHOT_DIR redirects snapshots for local stability dry runs; committed baselines come
  // only from the pinned image.
  snapshotPathTemplate: `${process.env["AGENTSIM_VISUAL_SNAPSHOT_DIR"] ?? "{testDir}/visual/__screenshots__"}/{arg}{ext}`,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide", scale: "css" } },
  webServer: {
    command: `pnpm --filter @agentsim/lab build && pnpm --filter @agentsim/lab preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
  },
});
