import { storageMessageChecks } from "../worker/message-checks.ts";
import { runStorageWorker, type WorkerScope } from "../worker/storage-worker.ts";

// Worker entry for browser tests (full message checks on); production uses apps/lab/src/workers/storage.worker.ts.
runStorageWorker(self as unknown as WorkerScope, storageMessageChecks);
