import { parseFilter } from "@agentsim/trace";
import type { UserDataStore } from "@agentsim/storage";

/** A filter of the log console the researcher kept under a name (UI-SPEC section 5.1: saved filters). Kept in `user_data`, in the order they were saved. */
export interface SavedFilter {
  readonly name: string;
  readonly text: string;
}

const NAMESPACE = "log";
const KEY = "savedFilters";
export const MAX_SAVED_FILTERS = 50;
/** A name is 1 to 40 printable characters (no control characters). */
const isName = (n: string): boolean => n.length >= 1 && n.length <= 40 && [...n].every((c) => c.charCodeAt(0) >= 32);

/** What `user_data` holds, read defensively: anything that is not a name and a filter that parses is left out. */
export async function loadSavedFilters(store: Pick<UserDataStore, "get">): Promise<SavedFilter[]> {
  const raw = await store.get(NAMESPACE, KEY);
  if (!Array.isArray(raw)) return [];
  const out: SavedFilter[] = [];
  for (const x of raw) {
    const f = x as { name?: unknown; text?: unknown };
    if (typeof f?.name !== "string" || typeof f.text !== "string" || !isName(f.name) || !parseFilter(f.text).ok) continue;
    if (!out.some((o) => o.name === f.name)) out.push({ name: f.name, text: f.text });
  }
  return out.slice(0, MAX_SAVED_FILTERS);
}

/** The list with `name` set to `text` (replacing a filter of that name, else added at the end); a name or a filter that is not valid leaves it as it was. */
export function withSavedFilter(list: readonly SavedFilter[], name: string, text: string): SavedFilter[] {
  const n = name.trim();
  if (!isName(n) || !parseFilter(text).ok) return [...list];
  const at = list.findIndex((f) => f.name === n);
  const next = at < 0 ? [...list, { name: n, text }] : list.map((f, i) => (i === at ? { name: n, text } : f));
  return next.slice(0, MAX_SAVED_FILTERS);
}

export const withoutSavedFilter = (list: readonly SavedFilter[], name: string): SavedFilter[] => list.filter((f) => f.name !== name);

export async function storeSavedFilters(store: Pick<UserDataStore, "set">, list: readonly SavedFilter[]): Promise<void> {
  await store.set(NAMESPACE, KEY, list);
}
