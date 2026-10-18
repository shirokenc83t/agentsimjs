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

/**
 * Shared transaction logic: BEGIN at depth 0, SAVEPOINT when nested (so batches can isolate failures). `fn` may return a promise: the
 * transaction then stays open across its awaits and ends when the promise settles (the storage worker serves one request at a time, so nothing
 * else uses the connection meanwhile except reads and nested transactions of its own).
 */
export function createTransactionRunner(exec: (sql: string) => void): <T>(fn: () => T) => T {
  let depth = 0;
  return <T>(fn: () => T): T => {
    const sp = `sp_${depth}`;
    const top = depth === 0;
    exec(top ? "BEGIN" : `SAVEPOINT ${sp}`);
    depth++;
    const commit = () => exec(top ? "COMMIT" : `RELEASE ${sp}`);
    const rollback = () => exec(top ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    let out: T;
    try {
      out = fn();
    } catch (e) {
      depth--;
      rollback();
      throw e;
    }
    if (out !== null && typeof out === "object" && typeof (out as { then?: unknown }).then === "function") {
      return (out as unknown as Promise<unknown>).then(
        (v) => {
          depth--;
          commit();
          return v;
        },
        (e: unknown) => {
          depth--;
          rollback();
          throw e;
        },
      ) as T;
    }
    depth--;
    commit();
    return out;
  };
}
