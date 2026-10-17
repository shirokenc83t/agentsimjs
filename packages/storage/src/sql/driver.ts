/** Values that cross the SQL boundary. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/**
 * Minimal synchronous SQLite driver (ADR-0020). Port implementations are written once against it;
 * drivers exist for sqlite-wasm (storage worker) and node:sqlite (tests/CLI). Swappable to
 * better-sqlite3 without changing ports or tests.
 */
export interface SqlDriver {
  /** Executes one or more statements without parameters (DDL, migrations). */
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  all<R extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): R[];
  get<R extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): R | undefined;
  /** Runs `fn` inside a transaction; rolls back if it throws. Nested calls use savepoints. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Shared transaction logic: BEGIN at depth 0, SAVEPOINT when nested (so batches can isolate failures). */
export function createTransactionRunner(exec: (sql: string) => void): <T>(fn: () => T) => T {
  let depth = 0;
  return <T>(fn: () => T): T => {
    const sp = `sp_${depth}`;
    exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
    depth++;
    try {
      const out = fn();
      exec(depth === 1 ? "COMMIT" : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      depth--;
    }
  };
}
