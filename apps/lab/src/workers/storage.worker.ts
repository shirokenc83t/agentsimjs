/// <reference lib="webworker" />
import { initValidation } from "@agentsim/core";
import { runStorageWorker, storageMessageChecks } from "@agentsim/storage";

initValidation();
// Internal peer: message envelopes checked in dev only (ADR-0018); persisted data is always validated.
runStorageWorker(self, import.meta.env.DEV ? storageMessageChecks : undefined);
