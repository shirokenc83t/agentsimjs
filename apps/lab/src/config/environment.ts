import { createStorageClient, DEFAULT_QUOTA_THRESHOLD_BYTES, type StorageClient } from "@agentsim/storage";
import { readBootSetting, writeBootSetting } from "@agentsim/ui";
import { SimClient } from "../sim/sim-client.ts";

/**
 * Composition root (ADR-0020): the only place that maps the environment to adapters.
 * No `if (hosted)` anywhere else.
 */
export type EnvironmentMode = "local" | "hosted";

export interface Environment {
  readonly mode: EnvironmentMode;
  createStorage(): StorageClient;
  createSim(tickRateHz: number): SimClient;
}

/** Per-viewer boot setting (Settings workspace), needed before storage opens; read once at startup. */
export function readQuotaThreshold(): number {
  const v = Number(readBootSetting("storage.quotaThreshold"));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_QUOTA_THRESHOLD_BYTES;
}

export function writeQuotaThreshold(bytes: number): void {
  writeBootSetting("storage.quotaThreshold", String(Math.max(0, Math.round(bytes))));
}

/** Test switch: `?simulate-no-opfs` exercises the fallback path end to end. */
function simulateNoOpfs(): boolean {
  return new URLSearchParams(location.search).has("simulate-no-opfs");
}

const local: Environment = {
  mode: "local",
  createStorage: () =>
    createStorageClient(new Worker(new URL("../workers/storage.worker.ts", import.meta.url), { type: "module", name: "storage" }), {
      quotaThresholdBytes: readQuotaThreshold(),
      ...(simulateNoOpfs() ? { simulateNoOpfs: true } : {}),
    }),
  createSim: (tickRateHz) =>
    new SimClient(new Worker(new URL("../workers/sim.worker.ts", import.meta.url), { type: "module", name: "sim" }), tickRateHz),
};

export function resolveEnvironment(mode: string | undefined): Environment {
  if (mode === undefined || mode === "" || mode === "local") return local;
  if (mode === "hosted") throw new Error("The 'hosted' environment needs the remote storage adapters, which arrive in phase FB.");
  throw new Error(`Unknown environment '${mode}' (expected 'local' or 'hosted').`);
}
