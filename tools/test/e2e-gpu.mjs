// `pnpm test:e2e:gpu`: the e2e suite on a hardware GPU (ADR-0022). Display-rate assertions are gated
// here; the measured fps, GPU and browser version are written to bench/local/e2e-gpu.json for CHANGELOG.
import { execSync } from "node:child_process";

execSync("pnpm exec playwright test --project=e2e", { stdio: "inherit", env: { ...process.env, AGENTSIM_E2E_GPU: "1" } });
