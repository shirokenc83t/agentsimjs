import type { UserDataStore } from "@agentsim/storage";

/** The two appearance preferences besides the theme: no motion at all, and the dot grid of the dock area. Kept in `user_data`, like the theme. */
export interface Appearance {
  readonly reducedMotion: boolean;
  readonly dockGrid: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { reducedMotion: false, dockGrid: true };
const NAMESPACE = "ui";
const KEYS = { reducedMotion: "reducedMotion", dockGrid: "dockGrid" } as const;

export async function loadAppearance(store: Pick<UserDataStore, "get">): Promise<Appearance> {
  const [motion, grid] = await Promise.all([store.get(NAMESPACE, KEYS.reducedMotion), store.get(NAMESPACE, KEYS.dockGrid)]);
  return { reducedMotion: typeof motion === "boolean" ? motion : DEFAULT_APPEARANCE.reducedMotion, dockGrid: typeof grid === "boolean" ? grid : DEFAULT_APPEARANCE.dockGrid };
}

export async function saveAppearance(store: Pick<UserDataStore, "set">, a: Appearance): Promise<void> {
  await Promise.all([store.set(NAMESPACE, KEYS.reducedMotion, a.reducedMotion), store.set(NAMESPACE, KEYS.dockGrid, a.dockGrid)]);
}

/** Puts the preferences on the document element (`data-motion`, `data-dockgrid`); the stylesheets follow them. */
export function applyAppearance(a: Appearance): void {
  const d = document.documentElement.dataset;
  if (a.reducedMotion) d["motion"] = "reduce";
  else delete d["motion"];
  if (a.dockGrid) delete d["dockgrid"];
  else d["dockgrid"] = "off";
}
