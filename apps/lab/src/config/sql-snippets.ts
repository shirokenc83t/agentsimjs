import type { UserDataStore } from "@agentsim/storage";

/** A statement of the SQL console kept under a name, in `user_data`, in the order it was saved. */
export interface SqlSnippet {
  readonly name: string;
  readonly sql: string;
}

const NAMESPACE = "sql";
const KEY = "snippets";
export const MAX_SNIPPETS = 50;
const MAX_SQL_CHARS = 20_000;
const isName = (n: string): boolean => n.length >= 1 && n.length <= 40 && [...n].every((c) => c.charCodeAt(0) >= 32);

export async function loadSnippets(store: Pick<UserDataStore, "get">): Promise<SqlSnippet[]> {
  const raw = await store.get(NAMESPACE, KEY);
  if (!Array.isArray(raw)) return [];
  const out: SqlSnippet[] = [];
  for (const x of raw) {
    const s = x as { name?: unknown; sql?: unknown };
    if (typeof s?.name !== "string" || typeof s.sql !== "string" || !isName(s.name) || s.sql.trim() === "" || s.sql.length > MAX_SQL_CHARS) continue;
    if (!out.some((o) => o.name === s.name)) out.push({ name: s.name, sql: s.sql });
  }
  return out.slice(0, MAX_SNIPPETS);
}

/** The list with `name` set to `sql` (replacing a snippet of that name, else added at the end); a name or a statement that is not valid leaves it as it was. */
export function withSnippet(list: readonly SqlSnippet[], name: string, sql: string): SqlSnippet[] {
  const n = name.trim();
  if (!isName(n) || sql.trim() === "" || sql.length > MAX_SQL_CHARS) return [...list];
  const at = list.findIndex((s) => s.name === n);
  const next = at < 0 ? [...list, { name: n, sql }] : list.map((s, i) => (i === at ? { name: n, sql } : s));
  return next.slice(0, MAX_SNIPPETS);
}

export const withoutSnippet = (list: readonly SqlSnippet[], name: string): SqlSnippet[] => list.filter((s) => s.name !== name);

export async function storeSnippets(store: Pick<UserDataStore, "set">, list: readonly SqlSnippet[]): Promise<void> {
  await store.set(NAMESPACE, KEY, list);
}
