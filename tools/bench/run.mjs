// `pnpm bench`: Node benches (Vitest), production build + bundle size, browser benches (Playwright),
// then threshold check. `--gpu` runs the browser benches on a hardware GPU (ADR-0022).
// Results land in bench/results/ (git-ignored; uploaded as CI artifacts).
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

const gpu = process.argv.includes("--gpu");
const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });

rmSync("bench/results", { recursive: true, force: true });
run("pnpm exec vitest run --project bench", { AGENTSIM_BENCH: "1" });
run("pnpm --filter @agentsim/lab build");
run("node tools/bench/bundle.mjs");
run("pnpm exec playwright test -c bench/playwright.bench.config.ts", gpu ? { AGENTSIM_BENCH_GPU: "1" } : {});
run(`node tools/bench/check.mjs${gpu ? " --gpu" : ""}`);
