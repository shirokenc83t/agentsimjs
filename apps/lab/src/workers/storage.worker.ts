/// <reference lib="webworker" />
import { initValidation } from "@agentsim/core";
import { runStorageWorker, storageMessageChecks } from "@agentsim/storage";
import { loadReplayModule } from "./replay-registry.ts";

initValidation();
// Internal peer: message envelopes checked in dev only (ADR-0018); persisted data is always validated.
// Replay reads (belief map at a tick, a run's world) come from a module loaded when the first one is asked for (ADR-0035 item 9).
runStorageWorker(self, import.meta.env.DEV ? storageMessageChecks : undefined, { replay: loadReplayModule });
