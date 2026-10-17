import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";

const browserTests = "**/*.browser.test.{ts,tsx}";
/** Long determinism runs (full reference runs with sensing): their own project, `pnpm test:determinism`. */
const determinismTests = "**/*.determinism.test.ts";
const domTests = ["packages/ui/**/*.test.{ts,tsx}", "apps/**/src/**/*.test.{ts,tsx}"];
const excludes = ["**/node_modules/**", "**/dist/**", "**/e2e/**"];

// Benchmarks run only via `pnpm bench` (tools/bench/run.mjs sets AGENTSIM_BENCH).
const benchProject = {
  // One file at a time: parallel benchmarks disturb each other's timings and race on bench/results/*.json.
  test: { name: "bench", environment: "node" as const, include: ["**/*.bench.ts"], exclude: excludes, testTimeout: 120_000, fileParallelism: false },
};

// Three environments (ADR-0021): node, jsdom (components), real browser (storage worker, OPFS).
export default defineConfig({
  test: {
    projects: [
      ...(process.env["AGENTSIM_BENCH"] ? [benchProject] : []),
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts", "tools/**/*.test.ts"],
          exclude: [...excludes, browserTests, "**/*.xengine.test.ts", determinismTests, ...domTests],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: domTests,
          exclude: [...excludes, browserTests, determinismTests],
          setupFiles: ["tools/test/setup-dom.ts"],
        },
      },
      {
        // Full reference runs with sensing (F2): seconds each, so not in `pnpm test`; CI runs them in a parallel job.
        test: {
          name: "determinism",
          environment: "node",
          include: [determinismTests],
          exclude: excludes,
          testTimeout: 120_000,
        },
      },
      {
        // Cross-engine determinism (ADR-0023): the same golden checks in Chromium and Firefox.
        test: {
          name: "xengine",
          include: ["**/*.xengine.test.ts"],
          exclude: excludes,
          testTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }, { browser: "firefox" }],
          },
        },
      },
      {
        optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"], include: ["typebox", "typebox/system", "typebox/value"] },
        worker: { format: "es" },
        test: {
          name: "browser",
          include: [browserTests],
          exclude: excludes,
          testTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
