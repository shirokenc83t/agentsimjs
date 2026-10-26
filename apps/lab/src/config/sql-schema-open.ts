import type { UserDataStore } from "@agentsim/storage";

const NAMESPACE = "sql";
const KEY = "schemaOpen";

/** Whether the researcher left the SQL console's schema tree open (saved per user in `user_data`); undefined when they never chose, and the tree is open. */
export async function loadSchemaOpen(store: Pick<UserDataStore, "get">): Promise<boolean | undefined> {
  const raw = await store.get(NAMESPACE, KEY);
  return typeof raw === "boolean" ? raw : undefined;
}

export async function storeSchemaOpen(store: Pick<UserDataStore, "set">, open: boolean): Promise<void> {
  await store.set(NAMESPACE, KEY, open);
}
