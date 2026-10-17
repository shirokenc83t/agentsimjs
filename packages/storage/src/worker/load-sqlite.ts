import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

let loading: Promise<Sqlite3Static> | undefined;

/** Lazy-loads the ~1 MB SQLite WASM module, only inside the storage worker (ADR-0010). */
export function loadSqlite(): Promise<Sqlite3Static> {
  loading ??= import("@sqlite.org/sqlite-wasm").then((m) => m.default());
  return loading;
}
