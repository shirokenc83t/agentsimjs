import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview-react";
import type { PanelId } from "./registry.tsx";
import { panelNumber, tabTitle, type PresetPanel, type WorkspacePreset } from "./presets.ts";
import { PANELS } from "./registry.tsx";

/**
 * What can be done to a panel's window (ADR-0042 §7): float it over the dock or dock it back, maximize and restore, close, collapse a floating window to its title
 * bar and open it again, focus the next panel or one by its number. Every one of them is reached from the window buttons, the palette and the keyboard, through
 * these functions.
 */

/** Size of a window that a panel floats into. */
export const FLOAT_SIZE = { width: 440, height: 340 } as const;
/** Height (px) of a collapsed floating window: its title bar. */
export const COLLAPSED_HEIGHT_PX = 29;

export const isFloating = (panel: IDockviewPanel): boolean => panel.api.location.type === "floating";

export function floatPanel(api: DockviewApi, panel: IDockviewPanel): void {
  if (isFloating(panel)) return;
  api.addFloatingGroup(panel, { ...FLOAT_SIZE, x: 96, y: 96 });
}

const POSITION = { left: "left", right: "right", above: "top", below: "bottom" } as const;

/**
 * Puts a floating panel back in the grid where its preset puts it (beside the panel it names, on the side it names) when that panel is docked; otherwise as a tab
 * of the first docked group. Returns false when there is no docked group to receive it.
 */
export function dockPanel(api: DockviewApi, panel: IDockviewPanel, preset?: WorkspacePreset): boolean {
  if (!isFloating(panel)) return true;
  const place = preset?.panels.find((p) => p.id === panel.id)?.position;
  const beside = place ? api.getPanel(place.referencePanel) : undefined;
  if (place && beside && !isFloating(beside)) {
    panel.api.moveTo({ group: beside.group, position: POSITION[place.direction] });
    return true;
  }
  const target = api.groups.find((g) => g.api.location.type === "grid");
  if (!target) return false;
  panel.api.moveTo({ group: target });
  return true;
}

export function toggleMaximize(api: DockviewApi, panel: IDockviewPanel): void {
  if (panel.api.isMaximized()) api.exitMaximizedGroup();
  else panel.api.maximize();
}

export function closePanel(panel: IDockviewPanel): void {
  panel.api.close();
}

// The height a window had before it was collapsed: what opening it again restores.
const before = new WeakMap<DockviewGroupPanel, number>();

/** A floating window is collapsed when it is no taller than its title bar (so a saved layout that holds one collapsed is read the same way). */
export const isCollapsed = (group: DockviewGroupPanel): boolean => group.api.location.type === "floating" && group.height <= COLLAPSED_HEIGHT_PX + 2;

/** Marks the collapsed windows for the stylesheet (their body is hidden); call after the layout changes or is loaded. */
export function syncCollapsed(api: DockviewApi): void {
  for (const g of api.groups) g.element.classList.toggle("collapsed", isCollapsed(g));
}

/** Collapses a floating window to its title bar, or opens it again at the height it had. */
export function toggleCollapse(group: DockviewGroupPanel): void {
  if (group.api.location.type !== "floating") return;
  if (isCollapsed(group)) {
    group.element.classList.remove("collapsed");
    group.api.setSize({ height: before.get(group) ?? FLOAT_SIZE.height });
  } else {
    if (group.height > COLLAPSED_HEIGHT_PX + 2) before.set(group, group.height);
    group.element.classList.add("collapsed");
    group.api.setSize({ height: COLLAPSED_HEIGHT_PX });
  }
}

export function focusNext(api: DockviewApi): void {
  const panels = api.panels;
  if (panels.length === 0) return;
  const at = panels.findIndex((p) => p.id === api.activePanel?.id);
  panels[(at + 1) % panels.length]?.api.setActive();
}

/** The panel with this number in the workspace (the numbers of `tabTitle`), if it is open. */
export function panelByNumber(api: DockviewApi, preset: WorkspacePreset, n: number): IDockviewPanel | undefined {
  return api.panels.find((p) => panelNumber(preset, p.id as PanelId) === n);
}

export function focusNumber(api: DockviewApi, preset: WorkspacePreset, n: number): boolean {
  const panel = panelByNumber(api, preset, n);
  if (!panel) return false;
  if (isFloating(panel)) {
    const g = panel.group;
    if (isCollapsed(g)) toggleCollapse(g);
  }
  panel.api.setActive();
  return true;
}

/** Opens a panel of the preset that was closed, in the place the preset gives it, or focuses it when it is open. */
export function openPanel(api: DockviewApi, preset: WorkspacePreset, id: PanelId): void {
  const open = api.getPanel(id);
  if (open) {
    if (isFloating(open) && isCollapsed(open.group)) toggleCollapse(open.group);
    open.api.setActive();
    return;
  }
  const p = preset.panels.find((x) => x.id === id);
  addPresetPanel(api, preset, p ?? { id });
}

/** Adds a preset's panel to the dock: docked beside the one it names, or as a floating window. */
export function addPresetPanel(api: DockviewApi, preset: WorkspacePreset, p: PresetPanel): void {
  const base = { id: p.id, component: p.id, title: tabTitle(preset, p.id, PANELS[p.id].title) };
  if (p.floating) {
    const panel = api.addPanel({ ...base, floating: { width: p.floating.width, height: p.floating.height, position: { bottom: 16, right: 16 } } });
    before.set(panel.group, p.floating.height);
    if (p.floating.collapsed) {
      // Not `toggleCollapse`: the window has no size yet to be read as open.
      panel.group.element.classList.add("collapsed");
      panel.group.api.setSize({ height: COLLAPSED_HEIGHT_PX });
    }
    return;
  }
  const referenced = p.position && api.getPanel(p.position.referencePanel);
  api.addPanel({
    ...base,
    ...(referenced && p.position ? { position: { referencePanel: p.position.referencePanel, direction: p.position.direction } } : {}),
    ...(p.initialWidth === undefined ? {} : { initialWidth: p.initialWidth }),
  });
}

/** Lays a preset out from nothing (the first time, and on reset). */
export function applyPreset(api: DockviewApi, preset: WorkspacePreset): void {
  api.clear();
  for (const p of preset.panels) addPresetPanel(api, preset, p);
}
