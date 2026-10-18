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

/** Test switch: `?simulate-quota-headroom=<bytes>` gives storage a quota of what it holds plus this much (the quota pause, end to end). */
function quotaHeadroom(): number | undefined {
  const v = Number(new URLSearchParams(location.search).get("simulate-quota-headroom"));
  return v > 0 ? v : undefined;
}

/** Test switch: `?simulate-no-opfs` exercises the fallback path end to end. */
function simulateNoOpfs(): boolean {
  return new URLSearchParams(location.search).has("simulate-no-opfs");
}

/** Test switch: `?simulate-slow-writer=<ms>` makes every commit of recorder batches take this long first, so the persisted head trails the sim (the gap, end to end). */
function slowWriterMs(): number | undefined {
  const v = Number(new URLSearchParams(location.search).get("simulate-slow-writer"));
  return v > 0 ? v : undefined;
}

const local: Environment = {
  mode: "local",
  createStorage: () =>
    createStorageClient(new Worker(new URL("../workers/storage.worker.ts", import.meta.url), { type: "module", name: "storage" }), {
      quotaThresholdBytes: readQuotaThreshold(),
      ...(simulateNoOpfs() ? { simulateNoOpfs: true } : {}),
      ...(quotaHeadroom() === undefined ? {} : { simulateQuotaHeadroomBytes: quotaHeadroom() as number }),
      ...(slowWriterMs() === undefined ? {} : { simulateSlowWriterMs: slowWriterMs() as number }),
    }),
  createSim: (tickRateHz) =>
    new SimClient(new Worker(new URL("../workers/sim.worker.ts", import.meta.url), { type: "module", name: "sim" }), tickRateHz),
};

/**
 * Sets up the direct channel between the sim worker's recorder and the storage worker (ADR-0019 addition of 2026-10-17): one MessageChannel,
 * a port to each worker, none kept here, so trace records never pass through the main thread.
 */
export function connectRecorder(sim: SimClient, storage: StorageClient): void {
  const channel = new MessageChannel();
  sim.attachRecorderPort(channel.port1);
  storage.attachRecorderPort(channel.port2);
}

export function resolveEnvironment(mode: string | undefined): Environment {
  if (mode === undefined || mode === "" || mode === "local") return local;
  if (mode === "hosted") throw new Error("The 'hosted' environment needs the remote storage adapters, which arrive in phase FB.");
  throw new Error(`Unknown environment '${mode}' (expected 'local' or 'hosted').`);
}
