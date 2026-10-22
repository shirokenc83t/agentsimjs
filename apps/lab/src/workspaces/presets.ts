import type { PanelId } from "./registry.tsx";

/** Workspaces available in F0 (UI-SPEC §3, §11). Others arrive with their phases. */
export type WorkspaceId = "scene" | "debug" | "author" | "data" | "settings";

export interface PresetPanel {
  readonly id: PanelId;
  /** Where the panel goes relative to an earlier one (default: a tab next to the previous panel). */
  readonly position?: { readonly referencePanel: PanelId; readonly direction: "left" | "right" | "above" | "below" };
  /** Initial width (px) for side panels. */
  readonly initialWidth?: number;
  /** A panel that starts as a floating window (inside the app, ADR-0042 §1), not in the grid: its size, anchored to the bottom right, and whether it starts collapsed to its title bar. */
  readonly floating?: { readonly width: number; readonly height: number; readonly collapsed: boolean };
}

export interface WorkspacePreset {
  readonly id: WorkspaceId;
  readonly title: string;
  /** Default panels; the first one fills the area. */
  readonly panels: readonly PresetPanel[];
}

/** The Performance HUD: a floating window in every workspace, collapsed until opened (ADR-0042 §5). */
const PERF_WINDOW: PresetPanel = { id: "perf", floating: { width: 300, height: 400, collapsed: true } };

/**
 * Scene workspace (UI-SPEC §3): Scene 3D in the middle, Explorer left, Inspector right. Timeline and the log
 * console join in F3.
 */
export const WORKSPACES: readonly WorkspacePreset[] = [
  {
    id: "scene",
    title: "Scene",
    panels: [
      { id: "scene" },
      { id: "explorer", position: { referencePanel: "scene", direction: "left" }, initialWidth: 300 },
      { id: "inspector", position: { referencePanel: "scene", direction: "right" }, initialWidth: 340 },
      PERF_WINDOW,
    ],
  },
  // Debug (UI-SPEC §3, F3a M3): the Scene at the cursor, the Timeline under it, the event list and the Inspector beside it. Everything follows the shared cursor.
  {
    id: "debug",
    title: "Debug",
    panels: [
      { id: "scene" },
      { id: "timeline", position: { referencePanel: "scene", direction: "below" } },
      { id: "eventList", position: { referencePanel: "scene", direction: "right" }, initialWidth: 460 },
      { id: "inspector", position: { referencePanel: "eventList", direction: "below" } },
      PERF_WINDOW,
    ],
  },
  // Author (UI-SPEC §3): the scenario editor and the run configuration as tabs (the editor active).
  {
    id: "author",
    title: "Author",
    panels: [{ id: "runConfig" }, { id: "scenarioEditor" }, PERF_WINDOW],
  },
  { id: "data", title: "Data", panels: [{ id: "storage" }, PERF_WINDOW] },
  { id: "settings", title: "Settings", panels: [{ id: "settings" }, PERF_WINDOW] },
];

/** The number of a docked panel in its workspace (1-based, the order of the preset): it is in the tab's name and `Alt+number` focuses it. Floating windows have none. */
export function panelNumber(preset: WorkspacePreset, id: PanelId): number | undefined {
  const docked = preset.panels.filter((p) => !p.floating);
  const i = docked.findIndex((p) => p.id === id);
  return i < 0 ? undefined : i + 1;
}

/** The tab title of a panel: `[2] Explorer`. */
export function tabTitle(preset: WorkspacePreset, id: PanelId, title: string): string {
  const n = panelNumber(preset, id);
  return n === undefined ? title : `[${n}] ${title}`;
}

export const LAYOUT_NAMESPACE = "layout";
/**
 * Saved layouts are keyed with this version: a preset that gains panels (F1 e4: Explorer, Inspector; F3a: the Debug workspace) starts
 * from the new preset instead of a saved layout that lacks them.
 */
export const LAYOUT_VERSION = 5;
export const layoutKey = (workspace: WorkspaceId) => `${workspace}@${LAYOUT_VERSION}`;
