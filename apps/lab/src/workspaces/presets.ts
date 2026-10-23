import type { PanelId } from "./registry.tsx";

/** Workspaces available in F0 (UI-SPEC §3, §11). Others arrive with their phases. */
export type WorkspaceId = "scene" | "debug" | "author" | "data" | "settings";

export interface PresetPanel {
  readonly id: PanelId;
  /** Where the panel goes relative to an earlier one (default: a tab next to the previous panel). */
  readonly position?: { readonly referencePanel: PanelId; readonly direction: "left" | "right" | "above" | "below" };
  /** Initial width (px) for side panels. */
  readonly initialWidth?: number;
  /** Initial height (px) for panels below another: the Timeline is as tall as its lanes, not half the window. */
  readonly initialHeight?: number;
  /** A tab that does not take the focus of its group when the workspace is laid out: the panel the researcher came for stays in front, this one is a click away. */
  readonly background?: boolean;
  /** Laid out after the other docked panels (its number in the workspace is still its place in the list): a panel below the Scene alone is made once the column beside it exists. */
  readonly late?: boolean;
  /**
   * A panel that starts as a floating window (inside the app, ADR-0042 §1), not in the grid: its open size, whether it starts collapsed to its title bar, and where it
   * sits: at the bottom right of the panel it belongs to (`host`), `stack` windows up from the bottom of it (0 is the lowest), `side: "left"` at the bottom left of it instead
   * (the Overview and the Legend open together without covering each other: one at each side of the map).
   */
  readonly floating?: { readonly width: number; readonly height: number; readonly collapsed: boolean; readonly host?: PanelId | undefined; readonly stack?: number; readonly side?: "left" };
}

export interface WorkspacePreset {
  readonly id: WorkspaceId;
  readonly title: string;
  /** Default panels; the first one fills the area. */
  readonly panels: readonly PresetPanel[];
}

/**
 * The Performance HUD: a floating window inside the map of the Scene (Scene and Debug), collapsed until opened (ADR-0042 §5). Elsewhere it is closed and is opened from
 * the frame segment of the status bar or from the palette (`openPanel` falls back to this, open, at the bottom right of the dock).
 */
export const PERF_WINDOW: PresetPanel = { id: "perf", floating: { width: 300, height: 400, collapsed: true, host: "scene", stack: 0 } };
/** The windows of the Scene (ADR-0042 section 8): the Legend above the Performance window at the bottom right of the map and the Overview at its bottom left (open together they do not touch); all start collapsed. */
const OVERVIEW_WINDOW: PresetPanel = { id: "overview", floating: { width: 240, height: 200, collapsed: true, host: "scene", stack: 1, side: "left" } };
const LEGEND_WINDOW: PresetPanel = { id: "legend", floating: { width: 340, height: 330, collapsed: true, host: "scene", stack: 1 } };

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
      OVERVIEW_WINDOW,
      LEGEND_WINDOW,
    ],
  },
  // Debug (UI-SPEC §3, F3a M3): the Scene at the cursor, the Timeline under it, the event list and the Inspector beside it. Everything follows the shared cursor.
  {
    id: "debug",
    title: "Debug",
    panels: [
      { id: "scene" },
      { id: "timeline", position: { referencePanel: "scene", direction: "below" }, initialHeight: 190, late: true },
      { id: "eventList", position: { referencePanel: "scene", direction: "right" }, initialWidth: 500 },
      { id: "inspector", position: { referencePanel: "eventList", direction: "below" }, initialHeight: 230 },
      { id: "traceTree", background: true },
      PERF_WINDOW,
    ],
  },
  // Author (UI-SPEC §3): the scenario editor and the run configuration as tabs (the editor active).
  {
    id: "author",
    title: "Author",
    panels: [{ id: "runConfig" }, { id: "scenarioEditor" }],
  },
  { id: "data", title: "Data", panels: [{ id: "storage" }, { id: "sqlConsole", position: { referencePanel: "storage", direction: "below" }, initialHeight: 330 }] },
  { id: "settings", title: "Settings", panels: [{ id: "settings" }] },
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
export const LAYOUT_VERSION = 9;
export const layoutKey = (workspace: WorkspaceId) => `${workspace}@${LAYOUT_VERSION}`;
