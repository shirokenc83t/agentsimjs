import { defineConfig, devices } from "@playwright/test";
import { gpuLaunchArgs } from "../tools/test/gpu.ts";

const PORT = 4174;
const gpu = !!process.env["AGENTSIM_BENCH_GPU"];

// Browser benchmarks (ADR-0021): production build, headless Chromium, one worker for stable timing.
export default defineConfig({
  testDir: "browser",
  testMatch: "**/*.bench.spec.ts",
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    launchOptions: { args: gpuLaunchArgs(gpu) },
  },
  webServer: {
    command: `pnpm --filter @agentsim/lab preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
