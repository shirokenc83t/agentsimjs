import { err, ok } from "@agentsim/core";
import type { ReplayHandlers } from "../replay.ts";
import { storageMessageChecks } from "../worker/message-checks.ts";
import { runStorageWorker, type WorkerScope } from "../worker/storage-worker.ts";

// Worker entry for browser tests (full message checks on); production uses apps/lab/src/workers/storage.worker.ts.
// The replay module is a stand-in that reads through the ports it is given: it proves the worker loads it on the first read, hands it the
// ports, and transfers the bytes it returns (the real module is tested in the lab, against the live run).
const replay = async (): Promise<ReplayHandlers> => ({
  async beliefAt(ports, runId, agentId, tick) {
    const run = await ports.runs.get(runId);
    if (!run) return err({ code: "unknown_run", message: `unknown run ${runId}` });
    return ok({ runId, agentId, tick, keyframeTick: 0, deltasApplied: 0, groups: { total: 1, from: 0, to: 1, groupChunks: 1, cached: 0, read: 1 }, sizeX: 2, sizeY: 2, chunkSize: 2, coords: new Uint16Array([0, 0]), data: new Uint8Array([tick, 1, 2, 3]) });
  },
  async world(ports, runId) {
    const run = await ports.runs.get(runId);
    if (!run) return err({ code: "unknown_run", message: `unknown run ${runId}` });
    return ok({ runId, sizeX: 2, sizeY: 2, resolutionM: 1, chunkSize: 2, zones: [], coords: new Uint16Array([0, 0]), data: new Uint8Array(16) });
  },
});
runStorageWorker(self as unknown as WorkerScope, storageMessageChecks, { replay });
