import type { SqlSchema } from "@agentsim/storage";

// Completion for the SQL console: schema-aware (tables, the columns of the tables the statement uses, `alias.column`) and aware of the payload (`json_extract(payload, '$.…')`
// offers the keys the latest payloads have). Pure: the text and the cursor in, the span to replace and the choices out.

export interface Completion {
  /** Where the text being completed starts (the choice replaces `from` to the cursor). */
  readonly from: number;
  readonly items: readonly string[];
}

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "JOIN", "LEFT JOIN", "ON", "AS", "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN", "DISTINCT", "HAVING",
  "UNION ALL", "WITH", "CASE", "WHEN", "THEN", "ELSE", "END", "COUNT(*)", "COUNT(", "SUM(", "AVG(", "MIN(", "MAX(", "json_extract(", "json_each(", "json_group_array(", "length(", "substr(", "round(", "coalesce(",
] as const;
const MAX_ITEMS = 12;

interface TableRef {
  readonly table: string;
  readonly alias: string | undefined;
}

/** The tables a statement names after FROM and JOIN, with the alias each is given. */
export function tablesOf(sql: string, known: ReadonlySet<string>): TableRef[] {
  const out: TableRef[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  const stop = new Set(["where", "join", "left", "inner", "on", "group", "order", "limit", "union", "having", "cross", "natural", "outer", "using", "offset"]);
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    const table = (m[1] as string).toLowerCase();
    if (!known.has(table)) continue;
    const alias = m[2] !== undefined && !stop.has(m[2].toLowerCase()) ? m[2] : undefined;
    out.push({ table, alias });
  }
  return out;
}

const rank = (items: readonly string[], prefix: string): string[] => {
  const p = prefix.toLowerCase();
  const starts = items.filter((i) => i.toLowerCase().startsWith(p));
  return [...new Set(starts)].filter((i) => i.toLowerCase() !== p || starts.length > 1);
};

/** What to offer at the cursor of the statement, or nothing. */
export function complete(sql: string, cursor: number, schema: SqlSchema): Completion {
  const before = sql.slice(0, cursor);
  const readable = schema.tables.filter((t) => t.readable);
  const known = new Set(readable.map((t) => t.name.toLowerCase()));

  // Inside a string that begins with `$.`: a path into a JSON payload.
  const path = /'(\$\.[A-Za-z0-9_.]*)$/.exec(before);
  if (path) {
    const typed = path[1] as string;
    const from = cursor - typed.length;
    const keys = schema.payloadKeys.map((k) => `$.${k}`);
    return { from, items: rank(keys, typed).slice(0, MAX_ITEMS) };
  }
  // Inside any other string: nothing.
  if ((before.match(/'/g)?.length ?? 0) % 2 === 1) return { from: cursor, items: [] };

  const token = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before)?.[0] ?? "";
  const from = cursor - token.length;
  const dot = token.lastIndexOf(".");
  if (dot >= 0) {
    // `table.` or `alias.`: its columns.
    const qualifier = token.slice(0, dot).toLowerCase();
    const part = token.slice(dot + 1);
    const refs = tablesOf(sql, known);
    const table = refs.find((r) => r.alias?.toLowerCase() === qualifier)?.table ?? (known.has(qualifier) ? qualifier : undefined);
    const columns = readable.find((t) => t.name.toLowerCase() === table)?.columns.map((c) => c.name) ?? [];
    return { from: from + dot + 1, items: rank(columns, part).slice(0, MAX_ITEMS) };
  }
  if (token === "") return { from: cursor, items: [] };
  const used = new Set(tablesOf(sql, known).map((r) => r.table));
  const columns = readable.filter((t) => used.has(t.name.toLowerCase())).flatMap((t) => t.columns.map((c) => c.name));
  const tables = readable.map((t) => t.name);
  const items = [...rank(columns, token), ...rank(tables, token), ...rank(KEYWORDS, token)];
  return { from, items: [...new Set(items)].slice(0, MAX_ITEMS) };
}
