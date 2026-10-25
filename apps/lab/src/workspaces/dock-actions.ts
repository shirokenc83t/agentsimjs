import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview-react";
import type { PanelId } from "./registry.tsx";
import { panelNumber, PERF_WINDOW, SQL_RESULT_WINDOW, TRACE_GRAPH_WINDOW, tabTitle, type PresetPanel, type WorkspacePreset } from "./presets.ts";
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
/** Width (px) of a collapsed floating window: its title and summary, not the width it has open. */
export const COLLAPSED_WIDTH_PX = 250;
/** Space (px) between windows stacked in a panel, and from its edges. */
const STACK_GAP_PX = 6;

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
  if (!target) {
    // A grid with nothing in it (the only panel of a workspace, the headless monitor, was floated): the panel is put back as the preset lays it out, as the first of the grid.
    const p = preset?.panels.find((x) => x.id === panel.id);
    if (!preset || !p) return false;
    panel.api.close();
    const { floating: _floating, ...docked } = p;
    addPresetPanel(api, preset, docked);
    return true;
  }
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

// The size a window had before it was collapsed: what opening it again restores.
const before = new WeakMap<DockviewGroupPanel, { width: number; height: number }>();
/** The width a collapsed window was given (a third of its host, at most COLLAPSED_WIDTH_PX), which it goes back to when collapsed again. */
const collapsedWidth = new WeakMap<DockviewGroupPanel, number>();

/** The width of a collapsed window of a host: the three of the Scene share one row along its edge, so a third of it less the gaps, at most COLLAPSED_WIDTH_PX and at least 150. */
function collapsedWidthIn(hostPx: number | undefined): number {
  return hostPx === undefined || hostPx <= 0 ? COLLAPSED_WIDTH_PX : Math.max(150, Math.min(COLLAPSED_WIDTH_PX, Math.floor((hostPx - 4 * STACK_GAP_PX) / 3)));
}

/** A floating window is collapsed when it is no taller than its title bar (so a saved layout that holds one collapsed is read the same way). */
export const isCollapsed = (group: DockviewGroupPanel): boolean =>
  group.api.location.type === "floating" && (group.height > 0 ? group.height <= COLLAPSED_HEIGHT_PX + 2 : group.element.classList.contains("collapsed"));

/** Marks the collapsed windows for the stylesheet (their body is hidden); call after the layout changes or is loaded. */
export function syncCollapsed(api: DockviewApi): void {
  // A group that is not laid out yet (no height) keeps what it was given when it was added.
  for (const g of api.groups) if (g.height > 0 || g.api.location.type !== "floating") g.element.classList.toggle("collapsed", isCollapsed(g));
}

/** Collapses a floating window to its title bar, or opens it again at the height it had. */
export function toggleCollapse(group: DockviewGroupPanel): void {
  if (group.api.location.type !== "floating") return;
  if (isCollapsed(group)) {
    group.element.classList.remove("collapsed");
    group.api.setSize(before.get(group) ?? FLOAT_SIZE);
  } else {
    if (group.height > COLLAPSED_HEIGHT_PX + 2) before.set(group, { width: group.width, height: group.height });
    group.element.classList.add("collapsed");
    group.api.setSize({ width: collapsedWidth.get(group) ?? COLLAPSED_WIDTH_PX, height: COLLAPSED_HEIGHT_PX });
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
  // The Performance window is in no workspace but the Scene and the Debug: opened from the status bar or the palette, it is open, at the bottom right of the dock.
  const p: PresetPanel = preset.panels.find((x) => x.id === id) ?? (id === "perf" && PERF_WINDOW.floating ? { id, floating: { ...PERF_WINDOW.floating, collapsed: false, host: undefined } } : id === "traceGraph" ? TRACE_GRAPH_WINDOW : id === "sqlResult" ? SQL_RESULT_WINDOW : { id });
  addPresetPanel(api, preset, p);
}

/**
 * Where a floating window starts: at the bottom right of the panel it belongs to (inside its bounds, `stack` windows up from its bottom), else at the bottom right
 * of the dock. The offsets are measured from the dock's own edges, which is what a floating group is anchored to.
 */
function floatingPosition(api: DockviewApi, f: NonNullable<PresetPanel["floating"]>): { bottom: number; right: number } | { bottom: number; left: number } {
  const host = f.host ? api.getPanel(f.host)?.group.element : undefined;
  const root = host?.closest(".dv-dockview");
  const h = host?.getBoundingClientRect();
  const r = root?.getBoundingClientRect();
  const stackPx = (f.stack ?? 0) * (COLLAPSED_HEIGHT_PX + STACK_GAP_PX);
  // Collapsed, they sit side by side along the bottom edge of their host, flush with it: a strip, not a stack over the map.
  const rowPx = (f.slot ?? 0) * (collapsedWidthIn(h?.width) + STACK_GAP_PX);
  if (f.collapsed && f.slot !== undefined) {
    if (!h || !r || h.width === 0) return f.side === "left" ? { bottom: STACK_GAP_PX, left: STACK_GAP_PX + rowPx } : { bottom: STACK_GAP_PX, right: STACK_GAP_PX + rowPx };
    const edge = Math.max(0, r.bottom - h.bottom) + STACK_GAP_PX;
    return f.side === "left" ? { bottom: edge, left: Math.max(0, h.left - r.left) + STACK_GAP_PX + rowPx } : { bottom: edge, right: Math.max(0, r.right - h.right) + STACK_GAP_PX + rowPx };
  }
  if (!h || !r || h.width === 0) return f.side === "left" ? { bottom: 16 + stackPx, left: 16 } : { bottom: 16 + stackPx, right: 16 };
  const bottom = Math.max(0, r.bottom - h.bottom) + STACK_GAP_PX + stackPx + 24;
  return f.side === "left" ? { bottom, left: Math.max(0, h.left - r.left) + STACK_GAP_PX + 4 } : { bottom, right: Math.max(0, r.right - h.right) + STACK_GAP_PX + 4 };
}

/** Adds a preset's panel to the dock: docked beside the one it names, or as a floating window. */
export function addPresetPanel(api: DockviewApi, preset: WorkspacePreset, p: PresetPanel): void {
  const base = { id: p.id, component: p.id, title: tabTitle(preset, p.id, PANELS[p.id].title) };
  if (p.floating) {
    const f = p.floating;
    // A big window (the trace graph) is as large as it asks and at most the dock less a margin, centred at the top; the small ones sit at the bottom right of their host.
    const big = f.width >= 700 && !f.collapsed;
    const hostWidth = f.host ? api.getPanel(f.host)?.group.element.getBoundingClientRect().width : undefined;
    const width = f.collapsed ? collapsedWidthIn(hostWidth) : big ? Math.min(f.width, Math.max(400, api.width - 24)) : f.width;
    const height = f.collapsed ? COLLAPSED_HEIGHT_PX : big ? Math.min(f.height, Math.max(300, api.height - 24)) : f.height;
    const position = big ? { top: 12, left: Math.max(12, Math.round((api.width - width) / 2)) } : floatingPosition(api, f);
    const panel = api.addPanel({ ...base, floating: { width, height, position } });
    before.set(panel.group, { width: f.width, height: f.height });
    if (f.collapsed) collapsedWidth.set(panel.group, width);
    if (f.collapsed) panel.group.element.classList.add("collapsed");
    return;
  }
  const referenced = p.position && api.getPanel(p.position.referencePanel);
  const front = api.activePanel;
  // A size given as a share of the dock wins when the dock has a size; the width keeps its minimum.
  const width = p.initialWidthPct !== undefined && api.width > 0 ? Math.max(p.minWidthPx ?? 0, Math.round(api.width * p.initialWidthPct)) : p.initialWidth;
  const height = p.initialHeightPct !== undefined && api.height > 0 ? Math.round(api.height * p.initialHeightPct) : p.initialHeight;
  api.addPanel({
    ...base,
    ...(referenced && p.position ? { position: { referencePanel: p.position.referencePanel, direction: p.position.direction } } : {}),
    ...(width === undefined ? {} : { initialWidth: width }),
    ...(height === undefined ? {} : { initialHeight: height }),
  });
  // A background tab: the panel that was in front stays there.
  if (p.background) front?.api.setActive();
}

/** Lays a preset out from nothing (the first time, and on reset). */
export function applyPreset(api: DockviewApi, preset: WorkspacePreset): void {
  api.clear();
  // The floating windows come last (they sit inside the panels already laid out), and a `late` panel after the docked ones beside it.
  const order = [...preset.panels.filter((p) => !p.floating && !p.late), ...preset.panels.filter((p) => !p.floating && p.late), ...preset.panels.filter((p) => p.floating)];
  for (const p of order) addPresetPanel(api, preset, p);
  // A column that must stay readable (the Log: 420 px for its summary column) is widened to its minimum once its neighbours are in place; they give the room.
  for (const p of preset.panels) {
    const panel = p.minWidthPx === undefined || p.floating ? undefined : api.getPanel(p.id);
    if (panel && p.minWidthPx !== undefined && panel.group.width > 0 && panel.group.width < p.minWidthPx) panel.api.setSize({ width: p.minWidthPx });
  }
}
