import type { TraceRecord } from "@agentsim/trace";
import { expect, it } from "vitest";
import { measure, recordResults } from "../../../../tools/bench/measure.ts";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { migrate } from "./migrations.ts";
import { createSqlPorts } from "./sql-storage.ts";

// Budget (ADR-0021): 10k trace records appended in batched transactions ≤ 250 ms (p95, Node).
const RECORDS = 10_000;
const BATCH = 500;

const records: TraceRecord[] = Array.from({ length: RECORDS }, (_, seq) => ({
  id: `run-000001#${seq}`, runId: "run-000001", seq, simTime: seq * 0.1, wallTime: 1_700_000_000_000,
  agentId: `uav-${String(seq % 20).padStart(3, "0")}`, source: `uav-${String(seq % 20).padStart(3, "0")}/actions`, kind: "action", tier: "S2",
  payload: { action: "goTo", params: { x: seq % 100, y: 42 }, status: "running" },
}));

it("storage.append10k", async () => {
  const metric = measure({
    iterations: 15,
    setup: () => {
      const db = openNodeSqlDriver(":memory:");
      migrate(db, () => 0);
      const ports = createSqlPorts(db, () => 0);
      void ports.runs.create({ runId: "run-000001", schemaVersion: 0, createdAtWallMs: 0, label: "bench", status: "running" });
      return { db, ports };
    },
    run: ({ db, ports }) => {
      // Same shape as the storage worker: one outer transaction per flush, one savepoint per append batch.
      for (let i = 0; i < RECORDS; i += BATCH) {
        db.transaction(() => void ports.trace.append(records.slice(i, i + BATCH)));
      }
    },
    teardown: ({ db }) => db.close(),
  });
  recordResults("node.json", { "storage.append10k": metric });
  expect(metric.samples).toBe(15);
});
