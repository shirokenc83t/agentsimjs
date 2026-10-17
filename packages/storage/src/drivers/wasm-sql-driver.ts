import type { Database, PreparedStatement } from "@sqlite.org/sqlite-wasm";
import { createTransactionRunner, type SqlDriver, type SqlRow, type SqlValue } from "../sql/driver.ts";

/**
 * Pool files with an open connection. Invariant (ADR-0020): exactly one connection per database file
 * in the storage worker — SQLite < 3.54 has a latent opfs-sahpool locking bug with several
 * simultaneous connections to one file in the same thread.
 */
const openPoolFiles = new Set<string>();

export class SecondConnectionError extends Error {
  readonly code = "second_connection";
  constructor(file: string) {
    super(`a connection to ${file} is already open (one connection per file, ADR-0020)`);
  }
}

/**
 * Opens a connection through `open` after claiming `file` in the registry. `file` is null for
 * in-memory databases, which are not pool files.
 */
export function openWasmSqlDriver(file: string | null, open: () => Database): SqlDriver {
  if (file !== null) {
    if (openPoolFiles.has(file)) throw new SecondConnectionError(file);
    openPoolFiles.add(file);
  }
  let db: Database;
  try {
    db = open();
  } catch (e) {
    if (file !== null) openPoolFiles.delete(file);
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
  let closed = false;
  // Prepared statements cached per SQL text; finalized on close.
  const cache = new Map<string, PreparedStatement>();
  const stmt = (sql: string, params: readonly SqlValue[]): PreparedStatement => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    s.reset(true);
    if (params.length > 0) s.bind(params as SqlValue[]);
    return s;
  };
  const rows = <R extends SqlRow>(sql: string, params: readonly SqlValue[], limit: number): R[] => {
    const s = stmt(sql, params);
    const out: R[] = [];
    try {
      while (out.length < limit && s.step()) out.push(s.get({}) as R);
    } finally {
      s.reset(true);
    }
    return out;
  };
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      const s = stmt(sql, params);
      try {
        s.step();
      } finally {
        s.reset(true);
      }
      return { changes: db.changes() };
    },
    all<R extends SqlRow>(sql: string, params: readonly SqlValue[] = []) {
      return rows<R>(sql, params, Number.POSITIVE_INFINITY);
    },
    get<R extends SqlRow>(sql: string, params: readonly SqlValue[] = []) {
      return rows<R>(sql, params, 1)[0];
    },
    transaction: createTransactionRunner((sql) => db.exec(sql)),
    close() {
      if (closed) return;
      closed = true;
      for (const s of cache.values()) s.finalize();
      cache.clear();
      db.close();
      if (file !== null) openPoolFiles.delete(file);
    },
  };
}

/** Exposed for diagnostics and tests. */
export function openPoolFileCount(): number {
  return openPoolFiles.size;
}
