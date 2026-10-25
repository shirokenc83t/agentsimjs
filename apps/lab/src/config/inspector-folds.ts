import type { UserDataStore } from "@agentsim/storage";

const NAMESPACE = "inspector";
const KEY = "folds";

/** The sections of the agent Inspector the researcher left open (saved per user in `user_data`), read defensively: only short names are kept. */
export async function loadInspectorFolds(store: Pick<UserDataStore, "get">): Promise<ReadonlySet<string> | undefined> {
  const raw = await store.get(NAMESPACE, KEY);
  if (!Array.isArray(raw)) return undefined;
  return new Set(raw.filter((x): x is string => typeof x === "string" && /^[a-z][A-Za-z0-9-]{0,31}$/.test(x)).slice(0, 32));
}

export async function storeInspectorFolds(store: Pick<UserDataStore, "set">, open: ReadonlySet<string>): Promise<void> {
  await store.set(NAMESPACE, KEY, [...open].sort());
}
