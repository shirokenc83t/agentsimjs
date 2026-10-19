import type { ReplayHandlers } from "@agentsim/storage";

/** The replay module is loaded by the storage worker when the first replay read asks for it (ADR-0021 lazy-loading registry; ADR-0035 item 9). */
export const loadReplayModule = (): Promise<ReplayHandlers> => import("./replay-module.ts").then((m) => m.handlers);
