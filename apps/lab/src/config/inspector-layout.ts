import type { UserDataStore } from "@agentsim/storage";
import { filterFitsView, MAX_PANES, type PaneSpec, type PaneView } from "../panels/inspector/panes.ts";

const NAMESPACE = "inspector";
const KEY = "layout";
const VIEWS: readonly PaneView[] = ["log", "table", "series"];

/** The panes of the multi-log inspector as the researcher left them (saved per user in `user_data`), read defensively: a pane that is not valid is left out. */
export async function loadInspectorLayout(store: Pick<UserDataStore, "get">): Promise<PaneSpec[] | undefined> {
  const raw = await store.get(NAMESPACE, KEY);
  if (!Array.isArray(raw)) return undefined;
  const out: PaneSpec[] = [];
  for (const x of raw) {
    const p = x as { id?: unknown; view?: unknown; filter?: unknown; title?: unknown };
    if (typeof p?.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(p.id) || typeof p.filter !== "string" || typeof p.title !== "string" || p.title.length > 60) continue;
    if (!VIEWS.includes(p.view as PaneView) || !filterFitsView(p.filter, p.view as PaneView) || out.some((o) => o.id === p.id)) continue;
    out.push({ id: p.id, view: p.view as PaneView, filter: p.filter, title: p.title });
  }
  return out.slice(0, MAX_PANES);
}

export async function storeInspectorLayout(store: Pick<UserDataStore, "set">, panes: readonly PaneSpec[]): Promise<void> {
  await store.set(NAMESPACE, KEY, panes);
}
