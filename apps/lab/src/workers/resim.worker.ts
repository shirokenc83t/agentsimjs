/// <reference lib="webworker" />
import { initValidation } from "@agentsim/core";
import { resimulateWindow } from "../sim/resim-window.ts";
import { fromWire, type ResimWorkerMessage, type ResimWorkerReply } from "../sim/resim-wire.ts";

// The worker that re-simulates one window (ADR-0035 section 3): a job at a time, started by the main thread, ended by it. It reads nothing from storage and writes nothing: it
// is given the documents, the snapshot with its sections, the inputs and the parent's checkpoints, and hands back the derived records and items. The live run, in the sim worker,
// is not touched.

initValidation();
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<ResimWorkerMessage>) => {
  const m = e.data;
  if (m.type !== "resim") return;
  let reply: ResimWorkerReply;
  try {
    const r = resimulateWindow(fromWire(m.request, () => Date.now()));
    reply = r.ok ? { type: "result", result: r.value } : { type: "error", error: r.error };
  } catch (err) {
    reply = { type: "error", error: { code: "run_failed", message: err instanceof Error ? err.message : String(err) } };
  }
  scope.postMessage(reply);
};
