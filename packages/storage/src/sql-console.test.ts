import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./sql/migrations.ts";
import { SQL_LIMITS, SqlConsole, statementsOf, type SqlResult } from "./sql-console.ts";

// The SQL console only reads (UI-SPEC section 7): every form of write is refused and the database is as it was; user_data is not readable; a long query is stopped and a
// writer that goes on in the meantime is not held. Run against sqlite-wasm, the engine the storage worker has (in memory here, as in its fallback mode: the same code).

let sqlite3: Sqlite3Static;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
}, 60_000);

function open(): { db: Database; console: SqlConsole } {
  const db = new sqlite3.oo1.DB(":memory:", "c");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.exec("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'r', 'running')");
  const insert = db.prepare("INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, agent_id, kind, payload, source_owner, source_component) VALUES ('run-000001', ?, ?, ?, 1, 'uav-001', 'event', ?, 'world', 'sim')");
  for (let i = 0; i < 50; i++) insert.bind([i, `run-000001#${i}`, i * 0.1, JSON.stringify({ op: i % 2 === 0 ? "start" : "end", name: "explore", n: i })]).stepReset();
  insert.finalize();
  db.exec("INSERT INTO user_data (namespace, key, value, updated_at_wall_ms) VALUES ('ui', 'secret', '\"hunter2\"', 1)");
  return { db, console: new SqlConsole({ sqlite3, db }) };
}

/** What the database is, in a form that changes if anything was written: its schema, every table's rows, and the connection's own count of changes. */
function fingerprint(db: Database): string {
  const tables = db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name") as string[];
  const counts = tables.map((t) => `${t}=${db.selectValue(`SELECT count(*) FROM "${t}"`)}`);
  return JSON.stringify([db.selectValues("SELECT sql FROM sqlite_schema ORDER BY name"), counts, db.selectValue("SELECT total_changes()"), db.selectValue("PRAGMA query_only"), db.selectValue("PRAGMA journal_mode")]);
}

const rows = (r: Awaited<ReturnType<SqlConsole["run"]>>): SqlResult => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe("statementsOf", () => {
  it("splits on semicolons outside strings, identifiers and comments, and drops the comments", () => {
    expect(statementsOf("SELECT 1")).toEqual(["SELECT 1"]);
    expect(statementsOf("SELECT 1;")).toEqual(["SELECT 1"]);
    expect(statementsOf("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    expect(statementsOf("SELECT ';' ; SELECT \";\"")).toEqual(["SELECT ';'", 'SELECT ";"']);
    expect(statementsOf("SELECT 'it''s;' AS a")).toEqual(["SELECT 'it''s;' AS a"]);
    expect(statementsOf("SELECT 1 -- ; DROP TABLE t\n, 2")).toEqual(["SELECT 1 \n, 2"]);
    expect(statementsOf("SELECT /* ; DROP */ 1")).toEqual(["SELECT   1"]);
    expect(statementsOf("/* x */ INSERT INTO t VALUES (1)")).toEqual(["INSERT INTO t VALUES (1)"]);
    expect(statementsOf("SELECT [a;b] FROM t; DROP TABLE t")).toEqual(["SELECT [a;b] FROM t", "DROP TABLE t"]);
    expect(statementsOf("  ;; ")).toEqual([]);
    expect(statementsOf("")).toEqual([]);
  });
});

describe("the SQL console reads", () => {
  it("returns the columns and the rows of a SELECT, a WITH, a VALUES and an EXPLAIN", async () => {
    const { console: c } = open();
    const a = rows(await c.run("SELECT seq, json_extract(payload, '$.op') AS op FROM trace_records WHERE seq < 3 ORDER BY seq", undefined));
    expect(a.columns).toEqual(["seq", "op"]);
    expect(a.rows).toEqual([[0, "start"], [1, "end"], [2, "start"]]);
    expect(a.truncated).toBe(false);
    expect(rows(await c.run("WITH x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x WHERE n < 3) SELECT n FROM x", undefined)).rows).toEqual([[1], [2], [3]]);
    expect(rows(await c.run("VALUES (1, 'a'), (2, 'b')", undefined)).rows).toEqual([[1, "a"], [2, "b"]]);
    expect(rows(await c.run("EXPLAIN QUERY PLAN SELECT * FROM trace_records WHERE run_id = 'run-000001'", undefined)).rows.length).toBeGreaterThan(0);
    expect(rows(await c.run("SELECT 1 AS a; ", undefined)).rows).toEqual([[1]]); // a trailing semicolon is not a second statement
  });

  it("reads the schema and the research tables", async () => {
    const { console: c } = open();
    expect(rows(await c.run("SELECT count(*) FROM trace_records", undefined)).rows).toEqual([[50]]);
    expect(rows(await c.run("SELECT count(*) FROM sqlite_schema", undefined)).rows[0]?.[0]).toBeGreaterThan(5);
    expect(rows(await c.run("SELECT run_id, label FROM runs", undefined)).rows).toEqual([["run-000001", "r"]]);
  });

  it("limits the rows and says there are more; a limit that is exactly the result is not truncated", async () => {
    const { console: c } = open();
    const cut = rows(await c.run("SELECT seq FROM trace_records ORDER BY seq", { maxRows: 10, timeoutMs: 5000 }));
    expect(cut.rows.length).toBe(10);
    expect(cut.truncated).toBe(true);
    const exact = rows(await c.run("SELECT seq FROM trace_records ORDER BY seq", { maxRows: 50, timeoutMs: 5000 }));
    expect(exact.rows.length).toBe(50);
    expect(exact.truncated).toBe(false);
  });

  it("shows a blob by its size, a big integer exactly, and cuts a very long text", async () => {
    const { console: c } = open();
    const r = rows(await c.run("SELECT zeroblob(7) AS b, 9007199254740993 AS big, 12 AS small, NULL AS nil, hex(zeroblob(5000)) AS long", undefined));
    expect(r.rows[0]?.slice(0, 4)).toEqual(["<blob 7 bytes>", "9007199254740993", 12, null]);
    expect((r.rows[0]?.[4] as string).length).toBe(SQL_LIMITS.cellChars + 1);
    expect(r.cellsCut).toBe(true);
  });

  it("explains a syntax error and an unknown table", async () => {
    const { console: c } = open();
    expect(await c.run("SELECT FROM WHERE", undefined)).toMatchObject({ ok: false, error: { code: "syntax" } });
    expect(await c.run("SELECT * FROM nonesuch", undefined)).toMatchObject({ ok: false, error: { code: "syntax", message: expect.stringContaining("nonesuch") } });
  });

  it("checks its limits and its input", async () => {
    const { console: c } = open();
    for (const bad of [{ maxRows: 0, timeoutMs: 1000 }, { maxRows: 1.5, timeoutMs: 1000 }, { maxRows: SQL_LIMITS.maxRows + 1, timeoutMs: 1000 }, { maxRows: 10, timeoutMs: 10 }, { maxRows: 10, timeoutMs: SQL_LIMITS.maxTimeoutMs + 1 }]) {
      expect(await c.run("SELECT 1", bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "limit_invalid" } });
    }
    expect(await c.run("   ", undefined)).toMatchObject({ ok: false, error: { code: "empty" } });
    expect(await c.run("-- nothing\n", undefined)).toMatchObject({ ok: false, error: { code: "empty" } });
    expect(await c.run("SELECT 1 /*" + "x".repeat(SQL_LIMITS.maxStatementChars) + "*/", undefined)).toMatchObject({ ok: false, error: { code: "too_long" } });
  });
});

describe("the SQL console never writes", () => {
  const WRITES = [
    "INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000099', 0, 1, 'x', 'running')",
    "REPLACE INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000001', 0, 1, 'x', 'running')",
    "UPDATE runs SET label = 'changed'",
    "DELETE FROM trace_records",
    "CREATE TABLE t (a)",
    "CREATE INDEX i ON trace_records (kind)",
    "CREATE VIEW v AS SELECT 1",
    "CREATE TRIGGER g AFTER INSERT ON runs BEGIN SELECT 1; END",
    "DROP TABLE trace_records",
    "DROP INDEX trace_records_run_time",
    "ALTER TABLE runs ADD COLUMN x TEXT",
    "ALTER TABLE runs RENAME TO runs2",
    "ATTACH DATABASE ':memory:' AS other",
    "ATTACH DATABASE '/tmp/stolen.db' AS other",
    "DETACH DATABASE main",
    "VACUUM",
    "VACUUM INTO '/tmp/copy.db'",
    "REINDEX",
    "ANALYZE",
    "PRAGMA journal_mode = WAL",
    "PRAGMA writable_schema = 1",
    "PRAGMA query_only = OFF",
    "PRAGMA user_version = 7",
    "PRAGMA foreign_keys = OFF",
    "PRAGMA table_info(runs)",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT s",
    "RELEASE s",
    "WITH x AS (SELECT 1) INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) SELECT 'run-000098', 0, 1, 'x', 'running' FROM x",
    "WITH x AS (SELECT 1) DELETE FROM trace_records",
    "WITH x AS (SELECT 1) UPDATE runs SET label = 'x'",
    "EXPLAIN INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000097', 0, 1, 'x', 'running')",
    "EXPLAIN DELETE FROM trace_records",
    "/* a comment first */ INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000096', 0, 1, 'x', 'running')",
    "-- a comment first\nDELETE FROM trace_records",
    "SELECT 1; DROP TABLE trace_records",
    "SELECT 1; SELECT 2",
    "SELECT load_extension('/tmp/evil.so')",
    "SELECT writefile('/tmp/x', 'y')",
    "SELECT readfile('/etc/passwd')",
    "SELECT * FROM pragma_journal_mode('delete')",
    "SELECT * FROM pragma_table_info('runs')",
    "SELECT * FROM pragma_writable_schema",
    "SELECT journal_mode FROM pragma_journal_mode",
    "select 1 from trace_records where 0; vacuum",
  ];

  it.each(WRITES)("refuses %s, and the database is as it was", async (statement) => {
    const { db, console: c } = open();
    const before = fingerprint(db);
    const r = await c.run(statement, undefined);
    expect(r.ok, statement).toBe(false);
    if (!r.ok) expect(["not_read_only", "denied", "multiple_statements", "syntax", "failed"]).toContain(r.error.code);
    expect(fingerprint(db), statement).toBe(before);
    // and the console left the connection as the worker needs it: a write of the worker's own goes through
    db.exec("INSERT INTO runs (run_id, schema_version, created_at_wall_ms, label, status) VALUES ('run-000055', 0, 1, 'worker', 'running')");
    expect(db.selectValue("SELECT label FROM runs WHERE run_id = 'run-000055'")).toBe("worker");
  });

  it("does not read user_data, however it is asked", async () => {
    const { db, console: c } = open();
    for (const q of [
      "SELECT * FROM user_data",
      "SELECT value FROM user_data WHERE key = 'secret'",
      "SELECT count(*) FROM user_data",
      "SELECT * FROM (SELECT * FROM user_data)",
      "SELECT 1 FROM runs, user_data",
      "WITH u AS (SELECT * FROM user_data) SELECT * FROM u",
      "SELECT (SELECT value FROM user_data LIMIT 1)",
      "SELECT * FROM main.user_data",
    ]) {
      expect(await c.run(q, undefined), q).toMatchObject({ ok: false, error: { code: "denied" } });
    }
    expect(db.selectValue("SELECT value FROM user_data WHERE key = 'secret'")).toBe('"hunter2"'); // the worker's own reads are not the console's
    expect(c.schema().tables.find((t) => t.name === "user_data")).toMatchObject({ readable: false, columns: [] });
  });

  it("leaves the authorizer, the progress handler and query_only off after every run, whatever the outcome", async () => {
    const { db, console: c } = open();
    await c.run("SELECT 1", undefined);
    await c.run("INSERT INTO runs VALUES (1)", undefined);
    await c.run("SELECT * FROM user_data", undefined);
    await c.run("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT count(*) FROM x", { maxRows: 10, timeoutMs: 300 });
    expect(db.selectValue("PRAGMA query_only")).toBe(0);
    db.exec("INSERT INTO user_data (namespace, key, value, updated_at_wall_ms) VALUES ('ui', 'k2', '1', 1)"); // no authorizer left to refuse it
    expect(db.selectValue("SELECT count(*) FROM user_data")).toBe(2);
  });

  it("the engine refuses a write too, on its own: with query_only on, a write fails whatever the authorizer says", () => {
    const { db } = open();
    db.exec("PRAGMA query_only = ON");
    expect(() => db.exec("DELETE FROM trace_records")).toThrow(/readonly|read-only|authorized|attempt to write/i);
    db.exec("PRAGMA query_only = OFF");
    expect(db.selectValue("SELECT count(*) FROM trace_records")).toBe(50);
  });
});

describe("a long statement is stopped, and a writer that goes on is not held", () => {
  const FOREVER = "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT count(*) FROM x";

  /** A writer of the worker's own on the same connection, every few ms, as the recorder's batches are: its gaps and its failures. */
  function writer(db: Database) {
    let seq = 1000;
    let last = performance.now();
    let maxGap = 0;
    let count = 0;
    let failures = 0;
    const id = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      try {
        db.exec({ sql: "INSERT INTO trace_records (run_id, seq, id, sim_time, wall_time, kind, payload, source_owner, source_component) VALUES ('run-000001', ?, ?, 99, 1, 'event', '{}', 'world', 'sim')", bind: [seq, `run-000001#${seq}`] });
        seq++;
        count++;
      } catch {
        failures++;
      }
    }, 3);
    return { stop: () => (clearInterval(id), { maxGap, count, failures }) };
  }

  it("a single step that runs long is cut at the step cap, and a writer is held no longer than that", async () => {
    const { db, console: c } = open();
    const w = writer(db);
    const t0 = performance.now();
    const r = await c.run(FOREVER, { maxRows: 10, timeoutMs: 30_000 });
    const took = performance.now() - t0;
    const stats = w.stop();
    expect(r).toMatchObject({ ok: false, error: { code: "too_slow" } });
    expect(took).toBeGreaterThanOrEqual(SQL_LIMITS.stepCapMs - 50);
    expect(took).toBeLessThan(SQL_LIMITS.stepCapMs + 600);
    expect(stats.failures).toBe(0);
    // The writer waited for the step, no more: its longest wait is about the step cap.
    expect(stats.maxGap).toBeLessThan(SQL_LIMITS.stepCapMs + 600);
  }, 30_000);

  it("the timeout of the console stops it sooner when it is set lower", async () => {
    const { console: c } = open();
    const t0 = performance.now();
    const r = await c.run(FOREVER, { maxRows: 10, timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(performance.now() - t0).toBeLessThan(900);
  }, 30_000);

  it("a statement that streams rows slowly is sliced: the writer goes on between the slices, and the timeout stops it", async () => {
    const { db, console: c } = open();
    const before = db.selectValue("SELECT count(*) FROM trace_records") as number;
    const w = writer(db);
    const slow = "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT n, length(hex(randomblob(150000))) FROM x";
    const r = await c.run(slow, { maxRows: 100_000, timeoutMs: 1_500 });
    const stats = w.stop();
    expect(r).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(stats.failures).toBe(0);
    expect(stats.count).toBeGreaterThan(40); // it wrote all along (every 3 ms, in the slices' gaps)
    expect(stats.maxGap).toBeLessThan(SQL_LIMITS.sliceMs + 250); // never held for more than a slice and a step
    expect(db.selectValue("SELECT count(*) FROM trace_records")).toBe(before + stats.count); // every write landed
  }, 30_000);

  it("is cancelled between slices, and says it was", async () => {
    const { console: c } = open();
    const signal = { cancelled: false };
    setTimeout(() => (signal.cancelled = true), 150);
    const t0 = performance.now();
    const r = await c.run("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT n, length(hex(randomblob(150000))) FROM x", { maxRows: 100_000, timeoutMs: 30_000 }, signal);
    expect(r).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(c.busy).toBe(false);
  }, 30_000);

  it("runs one statement at a time: a second says it is busy, and the first is not disturbed", async () => {
    const { console: c } = open();
    const signal = { cancelled: false };
    const first = c.run("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT n, length(hex(randomblob(150000))) FROM x", { maxRows: 100_000, timeoutMs: 30_000 }, signal);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.busy).toBe(true);
    expect(await c.run("SELECT 1", undefined)).toMatchObject({ ok: false, error: { code: "busy" } });
    signal.cancelled = true;
    expect(await first).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(rows(await c.run("SELECT 1", undefined)).rows).toEqual([[1]]);
  }, 30_000);
});

describe("the schema for completion", () => {
  it("lists the tables with their columns, marks user_data as not readable, and gives the keys of the latest payloads", () => {
    const { console: c } = open();
    const s = c.schema();
    const names = s.tables.map((t) => t.name);
    for (const t of ["runs", "trace_records", "trace_causes", "metrics", "snapshots", "belief_frames", "blobs"]) expect(names).toContain(t);
    expect(s.tables.find((t) => t.name === "trace_records")?.columns.map((x) => x.name)).toEqual(expect.arrayContaining(["run_id", "seq", "sim_time", "kind", "payload", "source_owner"]));
    expect(s.tables.find((t) => t.name === "metrics")?.columns.map((x) => x.name)).toEqual(["run_id", "source", "name", "tick", "sim_time", "value"]);
    expect(s.tables.find((t) => t.name === "user_data")).toMatchObject({ readable: false });
    expect(s.payloadKeys).toEqual(expect.arrayContaining(["op", "name", "n"]));
  });
});

afterAll(() => undefined);
