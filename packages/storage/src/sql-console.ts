import { err, ok, type CodedError, type Result } from "@agentsim/core";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

// The SQL console's executor (UI-SPEC section 7; ADR-0020): the researcher's statement run against the database, and only ever to read it.
//
// Where it runs: on the storage worker's own connection. The OPFS database is open once (one connection per file, ADR-0020), so there is no second connection to read on;
// the console is time-sliced instead, and says so. A statement is stepped for at most `sliceMs`, then the job yields to the worker's queue (the recorder's batches are
// stored in between), and a single step is cut short by the progress handler after `stepCapMs`: the writer is never held longer than that, and a query that cannot produce
// its next row within it is refused, not waited for. A cancel takes effect between slices.
//
// Why it cannot write, in four layers (a write that gets through any one is a stop):
//   1. the text: exactly one statement, and it begins with SELECT, WITH, VALUES or EXPLAIN;
//   2. the authorizer, installed while the console runs and removed after: only reading (SELECT, READ, the recursion of a CTE) and the functions that are not on the deny
//      list; it refuses INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH, DETACH, PRAGMA, transactions and savepoints, and the `pragma_*` table functions;
//   3. `sqlite3_stmt_readonly`: the prepared statement must say it does not write;
//   4. `PRAGMA query_only` on for each slice (and off again before the worker takes its next task): the engine itself refuses a write.
// And it does not read what is not research data: `user_data` (settings, and where provider keys will live) is denied to the authorizer.

export const SQL_LIMITS = {
  defaultRows: 10_000,
  maxRows: 100_000,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 60_000,
  /** A single step of the statement longer than this is cut short: it would hold the writer. */
  stepCapMs: 500,
  /** The job yields to the worker's queue after stepping this long. */
  sliceMs: 20,
  maxStatementChars: 100_000,
  /** A cell longer than this is cut (a payload can be large). */
  cellChars: 4096,
} as const;

export interface SqlRunLimits {
  readonly maxRows: number;
  readonly timeoutMs: number;
}

export type SqlCell = string | number | null;

export interface SqlResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlCell[])[];
  /** The row limit was reached: there are more rows than are returned. */
  readonly truncated: boolean;
  /** A cell was cut at `cellChars`. */
  readonly cellsCut: boolean;
  readonly elapsedMs: number;
}

export type SqlErrorCode = "empty" | "too_long" | "multiple_statements" | "not_read_only" | "denied" | "syntax" | "timeout" | "too_slow" | "cancelled" | "busy" | "limit_invalid" | "failed";
export type SqlError = CodedError<SqlErrorCode>;

export interface SqlSchema {
  readonly tables: readonly { readonly name: string; readonly columns: readonly { readonly name: string; readonly type: string }[]; readonly readable: boolean }[];
  /** The keys of the payloads of the latest records (for `json_extract(payload, '$.…')`). */
  readonly payloadKeys: readonly string[];
}

const DENIED_TABLES = new Set(["user_data"]);
const DENIED_FUNCTIONS = new Set(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "zipfile", "zipfile_cds"]);
const FIRST_WORDS = new Set(["select", "with", "values", "explain"]);

// Authorizer action codes (sqlite3.h).
const SQLITE_SELECT = 21;
const SQLITE_READ = 20;
const SQLITE_FUNCTION = 31;
const SQLITE_RECURSIVE = 33;
const SQLITE_OK = 0;
const SQLITE_DENY = 1;

/** The statements of a text, split on the semicolons that are not in a string, an identifier or a comment; each without its comments. */
export function statementsOf(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] as string;
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      cur += " ";
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      cur += c;
      i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) {
            cur += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (c === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const firstWord = (statement: string): string => /^[A-Za-z]+/.exec(statement)?.[0]?.toLowerCase() ?? "";

export interface SqlConsoleDeps {
  readonly sqlite3: Sqlite3Static;
  readonly db: Database;
  readonly now?: () => number;
  /** Gives the worker's queue a turn (the recorder's batches are stored in it). */
  readonly yieldToQueue?: () => Promise<void>;
}

/** A job that can be cancelled: `cancelled` is read between slices. */
export interface SqlJobSignal {
  cancelled: boolean;
}

export class SqlConsole {
  private readonly sqlite3: Sqlite3Static;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly yieldToQueue: () => Promise<void>;
  private running = false;

  constructor(deps: SqlConsoleDeps) {
    this.sqlite3 = deps.sqlite3;
    this.db = deps.db;
    this.now = deps.now ?? (() => performance.now());
    this.yieldToQueue = deps.yieldToQueue ?? (() => new Promise((r) => setTimeout(r, 0)));
  }

  get busy(): boolean {
    return this.running;
  }

  /** The limits as the console takes them: whole numbers inside the bounds. */
  static checkLimits(l: Partial<SqlRunLimits> | undefined): Result<SqlRunLimits, SqlError> {
    const maxRows = l?.maxRows ?? SQL_LIMITS.defaultRows;
    const timeoutMs = l?.timeoutMs ?? SQL_LIMITS.defaultTimeoutMs;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > SQL_LIMITS.maxRows) return err({ code: "limit_invalid", message: `the row limit is a whole number from 1 to ${SQL_LIMITS.maxRows}` });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > SQL_LIMITS.maxTimeoutMs) return err({ code: "limit_invalid", message: `the timeout is from 100 ms to ${SQL_LIMITS.maxTimeoutMs} ms` });
    return ok({ maxRows, timeoutMs });
  }

  /** Runs one statement and returns its rows (up to the limit), or why it was refused or stopped. */
  async run(sql: string, limits: Partial<SqlRunLimits> | undefined, signal: SqlJobSignal = { cancelled: false }): Promise<Result<SqlResult, SqlError>> {
    const lim = SqlConsole.checkLimits(limits);
    if (!lim.ok) return lim;
    if (typeof sql !== "string") return err({ code: "empty", message: "there is no statement" });
    if (sql.length > SQL_LIMITS.maxStatementChars) return err({ code: "too_long", message: `a statement is at most ${SQL_LIMITS.maxStatementChars} characters` });
    const parts = statementsOf(sql);
    if (parts.length === 0) return err({ code: "empty", message: "there is no statement" });
    if (parts.length > 1) return err({ code: "multiple_statements", message: "one statement at a time" });
    const statement = parts[0] as string;
    const word = firstWord(statement);
    if (!FIRST_WORDS.has(word)) {
      return err({ code: "not_read_only", message: `${word === "" ? "this" : word.toUpperCase()} is not allowed: the console only reads (SELECT, WITH, VALUES, EXPLAIN)` });
    }
    if (this.running) return err({ code: "busy", message: "a statement is already running: cancel it or wait" });
    this.running = true;
    try {
      return await this.execute(statement, lim.value, signal);
    } finally {
      this.running = false;
    }
  }

  private async execute(statement: string, lim: SqlRunLimits, signal: SqlJobSignal): Promise<Result<SqlResult, SqlError>> {
    const { capi } = this.sqlite3;
    const started = this.now();
    type Stmt = ReturnType<Database["prepare"]>;
    let stmt: Stmt | undefined;
    const rows: SqlCell[][] = [];
    let columns: string[] = [];
    let truncated = false;
    let cellsCut = false;
    let finished = false;

    const guarded = <T>(body: (sliceStart: number) => T): T => {
      const sliceStart = this.now();
      // The pragma first: the authorizer that follows would refuse it (and every pragma).
      this.db.exec("PRAGMA query_only = ON");
      capi.sqlite3_set_authorizer(this.db.pointer as never, ((_arg: unknown, code: number, a1: string | 0, a2: string | 0) => this.authorize(code, a1, a2)) as never, 0 as never);
      capi.sqlite3_progress_handler(this.db.pointer as never, 1000, (() => (this.now() - sliceStart > SQL_LIMITS.stepCapMs || this.now() - started > lim.timeoutMs ? 1 : 0)) as never, 0 as never);
      try {
        return body(sliceStart);
      } finally {
        // Back to what the worker's other tasks expect, before anything else runs: the authorizer and the handler off, then query_only.
        capi.sqlite3_progress_handler(this.db.pointer as never, 0, 0 as never, 0 as never);
        capi.sqlite3_set_authorizer(this.db.pointer as never, 0 as never, 0 as never);
        this.db.exec("PRAGMA query_only = OFF");
      }
    };

    try {
      // First slice: prepare under the authorizer (a write is refused here), check it, and begin.
      const prepared = guarded((): Result<void, SqlError> => {
        try {
          stmt = this.db.prepare(statement);
        } catch (e) {
          return err(classify(e, statement));
        }
        if (!capi.sqlite3_stmt_readonly(stmt.pointer as never)) return err({ code: "not_read_only", message: "this statement would write: the console only reads" });
        columns = Array.from({ length: stmt.columnCount }, (_, i) => (stmt as Stmt).getColumnName(i));
        return ok(undefined);
      });
      if (!prepared.ok) return prepared;
      const s = stmt as Stmt;

      while (!finished) {
        if (signal.cancelled) return err({ code: "cancelled", message: "cancelled" });
        if (this.now() - started > lim.timeoutMs) return err({ code: "timeout", message: `stopped after ${lim.timeoutMs} ms (the timeout of the console)` });
        const step = guarded((sliceStart): Result<void, SqlError> => {
          try {
            while (this.now() - sliceStart < SQL_LIMITS.sliceMs) {
              if (!s.step()) {
                finished = true;
                break;
              }
              const row: SqlCell[] = [];
              for (let i = 0; i < columns.length; i++) {
                const v = cell(s.get(i));
                if (v.cut) cellsCut = true;
                row.push(v.value);
              }
              rows.push(row);
              if (rows.length >= lim.maxRows) {
                // One more step says whether there is more than the limit.
                truncated = s.step();
                finished = true;
                break;
              }
            }
          } catch (e) {
            const interrupted = /INTERRUPT|interrupted/i.test(String((e as Error)?.message ?? e));
            if (interrupted) {
              return err(this.now() - started > lim.timeoutMs ? { code: "timeout", message: `stopped after ${lim.timeoutMs} ms (the timeout of the console)` } : { code: "too_slow", message: `a step took longer than ${SQL_LIMITS.stepCapMs} ms: the console shares the writer's connection and does not hold it; narrow the query (a run, a time window, an indexed column) or add a LIMIT` });
            }
            return err(classify(e, statement));
          }
          return ok(undefined);
        });
        if (!step.ok) return step;
        if (!finished) await this.yieldToQueue();
      }
      return ok({ columns, rows, truncated, cellsCut, elapsedMs: this.now() - started });
    } finally {
      try {
        (stmt as Stmt | undefined)?.finalize();
      } catch {
        // already finalized by an error
      }
    }
  }

  private authorize(code: number, a1: string | 0, a2: string | 0): number {
    switch (code) {
      case SQLITE_SELECT:
      case SQLITE_RECURSIVE:
        return SQLITE_OK;
      case SQLITE_READ: {
        const table = typeof a1 === "string" ? a1.toLowerCase() : "";
        return DENIED_TABLES.has(table) || table.startsWith("pragma_") ? SQLITE_DENY : SQLITE_OK;
      }
      case SQLITE_FUNCTION: {
        const fn = typeof a2 === "string" ? a2.toLowerCase() : "";
        return DENIED_FUNCTIONS.has(fn) || fn.startsWith("pragma_") ? SQLITE_DENY : SQLITE_OK;
      }
      default:
        return SQLITE_DENY;
    }
  }

  /** The tables, their columns, and the keys of the latest payloads: what completion offers. Not a statement of the researcher's: read here by the console itself. */
  schema(): SqlSchema {
    const names = this.db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as string[];
    const tables = names.map((name) => ({
      name,
      readable: !DENIED_TABLES.has(name.toLowerCase()),
      columns: DENIED_TABLES.has(name.toLowerCase())
        ? []
        : (this.db.selectObjects(`PRAGMA table_info(${quoteIdent(name)})`) as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type })),
    }));
    let payloadKeys: string[] = [];
    try {
      payloadKeys = this.db.selectValues("SELECT DISTINCT j.key FROM (SELECT payload FROM trace_records ORDER BY rowid DESC LIMIT 2000) t, json_each(t.payload) j WHERE j.type != 'null' ORDER BY 1 LIMIT 300") as string[];
    } catch {
      // no trace table, or a payload that is not an object
    }
    return { tables, payloadKeys };
  }
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

function classify(e: unknown, statement: string): SqlError {
  const message = String((e as Error)?.message ?? e);
  if (/SQLITE_AUTH|not authorized/i.test(message)) {
    const word = firstWord(statement);
    return { code: "denied", message: `${word === "" ? "this" : word.toUpperCase()} uses something the console does not allow (it only reads the research data, and not user_data)` };
  }
  if (/SQLITE_ERROR|syntax|no such|ambiguous/i.test(message)) return { code: "syntax", message: message.replace(/^SQLITE_ERROR: sqlite3 result code \d+: /, "") };
  return { code: "failed", message: message.replace(/^SQLITE_\w+: sqlite3 result code \d+: /, "") };
}

/** A value as the grid shows it: numbers and text as they are, a blob by its size, a long text cut. */
function cell(v: unknown): { value: SqlCell; cut: boolean } {
  if (v === null || v === undefined) return { value: null, cut: false };
  if (typeof v === "number") return { value: Number.isFinite(v) ? v : null, cut: false };
  if (typeof v === "bigint") return { value: Number.isSafeInteger(Number(v)) ? Number(v) : v.toString(), cut: false };
  if (typeof v === "string") return v.length > SQL_LIMITS.cellChars ? { value: `${v.slice(0, SQL_LIMITS.cellChars)}…`, cut: true } : { value: v, cut: false };
  if (v instanceof Uint8Array) return { value: `<blob ${v.length} bytes>`, cut: false };
  return { value: String(v), cut: false };
}
