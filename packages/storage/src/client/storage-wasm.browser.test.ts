import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, describe, expect, it } from "vitest";
import { describeStorageContract } from "../testing/contract.ts";
import { LATEST_SCHEMA_VERSION } from "../sql/migrations.ts";
import { createStorageClient, type StorageClient, type StorageClientOptions } from "./storage-client.ts";

const workers: { worker: Worker; client: StorageClient }[] = [];

function spawn(opts: Partial<StorageClientOptions> = {}): StorageClient {
  const worker = new Worker(new URL("../testing/storage-test.worker.ts", import.meta.url), { type: "module" });
  const client = createStorageClient(worker, { quotaThresholdBytes: 0, ...opts });
  workers.push({ worker, client });
  return client;
}

async function shutdown(client: StorageClient): Promise<void> {
  const i = workers.findIndex((w) => w.client === client);
  const entry = workers[i];
  if (!entry) return;
  workers.splice(i, 1);
  if (client.status().state === "ready") await client.admin.close();
  entry.worker.terminate();
}

afterEach(async () => {
  for (const w of [...workers]) await shutdown(w.client);
});

const header = (runId: string) => ({ runId, schemaVersion: 0, createdAtWallMs: 1, label: runId, status: "running" as const });
const rec = (runId: string, seq: number) => ({ id: `${runId}#${seq}`, runId, seq, simTime: seq, wallTime: 1, source: "world/sim", kind: "event" as const, payload: { seq } });

// The shared contract suite against the real storage worker (sqlite-wasm on opfs-sahpool).
describeStorageContract("sqlite-wasm storage worker (opfs-sahpool)", async () => {
  const client = spawn({ resetOnOpen: true });
  const ready = await client.ready();
  expect(ready.mode).toBe("opfs-sahpool");
  return { ports: client.ports, dispose: () => shutdown(client) };
});

describe("storage worker (browser)", () => {
  it("persists data across close and reopen", async () => {
    const a = spawn({ resetOnOpen: true });
    await a.ready();
    await a.ports.runs.create(header("run-000001"));
    await a.ports.trace.append([rec("run-000001", 0), rec("run-000001", 1)]);
    await shutdown(a);
    const b = spawn();
    await b.ready();
    expect(await b.ports.trace.count("run-000001")).toBe(2);
  });

  it("rejects requests queued behind close or sent after it, instead of hanging", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(header("run-000001"));
    // Sent back to back: append (before close), close, append (queued behind close).
    const before = c.ports.trace.append([rec("run-000001", 0)]);
    const closed = c.admin.close();
    const after = c.ports.trace.append([rec("run-000001", 1)]);
    expect((await before).ok).toBe(true);
    await closed;
    await expect(after).rejects.toMatchObject({ code: "closed" });
    await expect(c.ports.runs.list()).rejects.toMatchObject({ code: "closed" });
    // The committed append is durable.
    const reopened = spawn();
    await reopened.ready();
    expect(await reopened.ports.trace.count("run-000001")).toBe(1);
  });

  it("enforces one connection per database file", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    expect(await c.probeSecondConnection()).toBe("second_connection");
  });

  it("queues a second owner on the Web Lock until the first closes", async () => {
    const a = spawn({ resetOnOpen: true });
    await a.ready();
    const b = spawn();
    // Polled, not a fixed sleep: on slow CI runners the second worker may still be loading sqlite-wasm at 500 ms.
    await expect.poll(() => b.status().state, { timeout: 10_000 }).toBe("waiting-lock");
    await shutdown(a);
    expect((await b.ready()).mode).toBe("opfs-sahpool");
  });

  it("exports, then imports a validated file replacing the current database", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(header("run-000001"));
    const goTo = { inputId: "inp-000001", tick: 6, agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } };
    expect((await c.ports.runs.appendInputs("run-000001", [goTo])).ok).toBe(true);
    const snapshot = await c.admin.exportDb();
    expect(new TextDecoder().decode(snapshot.subarray(0, 15))).toBe("SQLite format 3");
    await c.ports.runs.create(header("run-000002"));
    const r = await c.admin.importDb(snapshot);
    expect(r.ok).toBe(true);
    expect((await c.ports.runs.list()).map((x) => x.runId)).toEqual(["run-000001"]);
    // Run inputs travel with the database (they are part of what the run ran).
    expect(await c.ports.runs.inputs("run-000001")).toEqual([goTo]);
  });

  it("rejects bad imports with stable codes and leaves the database untouched", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.runs.create(header("run-000001"));
    const good = await c.admin.exportDb();

    const sqlite3 = await sqlite3InitModule();
    const craft = (sql: string): Uint8Array => {
      const db = new sqlite3.oo1.DB(":memory:", "c");
      const p = sqlite3.wasm.allocFromTypedArray(good);
      const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
      sqlite3.capi.sqlite3_deserialize(db, "main", p, good.byteLength, good.byteLength, flags);
      db.exec(sql);
      const out = sqlite3.capi.sqlite3_js_db_export(db);
      db.close();
      return out;
    };
    const corrupt = good.slice();
    corrupt.fill(0xff, 1024);

    const cases: [Uint8Array, string][] = [
      [new TextEncoder().encode("definitely not a database".padEnd(200, ".")), "not_sqlite"],
      [corrupt, "corrupt|integrity_failed"],
      [craft("CREATE TABLE evil (x)"), "unknown_tables"],
      [craft("CREATE TRIGGER t AFTER INSERT ON runs BEGIN DELETE FROM runs; END"), "unexpected_objects"],
      [craft("CREATE VIEW v AS SELECT 1"), "unexpected_objects"],
      [craft("INSERT INTO schema_migrations VALUES (99, 'future', 0)"), "unknown_schema_version"],
      [
        craft(
          "INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000009', 0, 0, 'x', 'completed');" +
            "INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, kind, payload) VALUES ('run-000009', 0, 'a', 2, 0, 'event', '{}'), ('run-000009', 1, 'b', 1, 0, 'event', '{}')",
        ),
        "non_monotonic_trace",
      ],
    ];
    for (const [bytes, code] of cases) {
      const r = await c.admin.importDb(bytes);
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.error.code).toMatch(new RegExp(`^(${code})$`));
    }
    expect((await c.ports.runs.list()).map((x) => x.runId)).toEqual(["run-000001"]);
  });

  it("exports a single run as a standalone database", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    await c.ports.scenarios.saveVersion({ schemaVersion: 0, id: "alpha", name: "Alpha" });
    await c.ports.scenarios.saveVersion({ schemaVersion: 0, id: "alpha", name: "Alpha 2" });
    await c.ports.runs.create(header("run-000001"));
    await c.ports.runs.create({ ...header("run-000002"), scenarioId: "alpha", scenarioVersion: 2 });
    await c.ports.trace.append([rec("run-000001", 0), rec("run-000002", 0), rec("run-000002", 1)]);
    await c.ports.runs.appendInputs("run-000001", [{ inputId: "inp-000001", tick: 3, agentId: "ugv-001", name: "hold", params: {} }]);
    await c.ports.runs.appendInputs("run-000002", [{ inputId: "inp-000001", tick: 6, agentId: "ugv-001", name: "goTo", params: { xM: 50, yM: 10 } }]);
    const r = await c.admin.exportRun("run-000002");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    const p = sqlite3.wasm.allocFromTypedArray(r.value);
    sqlite3.capi.sqlite3_deserialize(db, "main", p, r.value.byteLength, r.value.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE);
    expect(db.selectValues("SELECT run_id FROM runs")).toEqual(["run-000002"]);
    expect(db.selectValue("SELECT count(*) FROM trace_records")).toBe(2);
    // The run's inputs travel with it, and only its own.
    expect(db.selectValues("SELECT run_id || ':' || input_id || ':' || name FROM run_inputs")).toEqual(["run-000002:inp-000001:goTo"]);
    // The scenario version the run used travels with it, and only that version.
    expect(db.selectValues("SELECT id || ':' || version FROM scenarios")).toEqual(["alpha:2"]);
    db.close();
    const missing = await c.admin.exportRun("run-000404");
    expect(missing.ok ? null : missing.error.code).toBe("unknown_run");
  });

  it("falls back to memory with a warning when OPFS is unavailable", async () => {
    const c = spawn({ simulateNoOpfs: true, lockName: "agentsim-db-fallback-test" });
    const s = await c.ready();
    expect(s.mode).toBe("memory-fallback");
    expect(s.warning).toMatch(/OPFS unavailable/);
    await c.ports.runs.create(header("run-000001"));
    expect((await c.admin.exportDb()).byteLength).toBeGreaterThan(0);
    expect((await c.admin.info()).mode).toBe("memory-fallback");
  });

  it("falls back to memory when the quota is below the threshold", async () => {
    const c = spawn({ quotaThresholdBytes: Number.MAX_SAFE_INTEGER, lockName: "agentsim-db-quota-test" });
    const s = await c.ready();
    expect(s.mode).toBe("memory-fallback");
    expect(s.warning).toMatch(/below the .* threshold/);
  });

  it("reports storage info", async () => {
    const c = spawn({ resetOnOpen: true });
    await c.ready();
    const info = await c.admin.info();
    expect(info.mode).toBe("opfs-sahpool");
    expect(info.sqliteVersion).toBe("3.53.4");
    expect(info.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(info.dbFileBytes).toBeGreaterThan(0);
  });
});
