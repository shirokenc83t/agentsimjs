import { err, ok } from "@agentsim/core";
import type { RecorderBatch } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { recorderAppend, reportCommit } from "./recorder-ingest.ts";
import type { PersistedHeadMessage, StorageToRecorder } from "./recorder-protocol.ts";

const batch = (tick: number, throughSeq: number, runId = "run-000001"): RecorderBatch => ({ runId, records: [], throughSeq, tick, simTimeS: tick * 0.1 });

function harness() {
  const toSim: StorageToRecorder[] = [];
  const toMain: PersistedHeadMessage[] = [];
  return { toSim, toMain, report: (items: Parameters<typeof reportCommit>[0]) => reportCommit(items, { postMessage: (m) => toSim.push(m) }, (m) => toMain.push(m)) };
}

describe("recorderAppend", () => {
  it("is a trace append of the batch's records, with no request id to answer", () => {
    const b = { ...batch(3, 9), records: [] };
    expect(recorderAppend(b)).toMatchObject({ type: "request", id: 0, op: "trace.append", args: [[]], recorder: b });
  });
});

describe("reportCommit", () => {
  it("reports the last batch of a transaction as the persisted head, to the sim worker and to the main thread", () => {
    const h = harness();
    h.report([
      { batch: batch(1, 4), result: ok(undefined) },
      { batch: batch(2, 9), result: ok(undefined) },
      { batch: batch(3, 12), result: ok(undefined) },
    ]);
    const head = { runId: "run-000001", throughSeq: 12, tick: 3, simTimeS: 0.30000000000000004 };
    expect(h.toSim).toEqual([{ type: "persisted", head }]);
    expect(h.toMain).toEqual([{ type: "persisted", head }]);
  });

  it("stops the head at the first refused batch and tells the sim worker which one and why", () => {
    const h = harness();
    h.report([
      { batch: batch(1, 4), result: ok(undefined) },
      { batch: batch(2, 9), result: err({ code: "duplicate_seq", message: "dup" }) },
      { batch: batch(3, 12), result: ok(undefined) },
    ]);
    expect(h.toSim.map((m) => m.type)).toEqual(["persisted", "rejected"]);
    expect(h.toSim[0]).toMatchObject({ head: { tick: 1, throughSeq: 4 } });
    expect(h.toSim[1]).toEqual({ type: "rejected", runId: "run-000001", code: "duplicate_seq", message: "dup" });
    expect(h.toMain).toHaveLength(1);
  });

  it("reports no head when the first batch is refused, and nothing for an empty commit", () => {
    const h = harness();
    h.report([{ batch: batch(1, 4), result: err({ code: "unknown_run", message: "no run" }) }]);
    expect(h.toSim.map((m) => m.type)).toEqual(["rejected"]);
    expect(h.toMain).toEqual([]);
    const g = harness();
    g.report([]);
    expect(g.toSim).toEqual([]);
  });

  it("works without a recorder port (a commit of batches the port has gone from) and still tells the main thread", () => {
    const toMain: PersistedHeadMessage[] = [];
    reportCommit([{ batch: batch(1, 4), result: ok(undefined) }], undefined, (m) => toMain.push(m));
    expect(toMain).toHaveLength(1);
  });
});
