import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createTransactionRunner, type SqlDriver, type SqlRow, type SqlValue } from "../sql/driver.ts";

/**
 * SqlDriver over `node:sqlite` (Node tests and CLI). `node:sqlite` is still experimental on Node 24
 * (ADR-0020): this is the only module that imports it, so it can be replaced by better-sqlite3.
 */
export function openNodeSqlDriver(path = ":memory:"): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  // Prepared statements are cached per SQL text (hot paths reuse a handful of statements).
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      const r = stmt(sql).run(...(params as SqlValue[]));
      return { changes: Number(r.changes) };
    },
    all<R extends SqlRow>(sql: string, params: readonly SqlValue[] = []) {
      return stmt(sql).all(...(params as SqlValue[])) as R[];
    },
    get<R extends SqlRow>(sql: string, params: readonly SqlValue[] = []) {
      return stmt(sql).get(...(params as SqlValue[])) as R | undefined;
    },
    transaction: createTransactionRunner((sql) => db.exec(sql)),
    close() {
      cache.clear();
      db.close();
    },
  };
}
