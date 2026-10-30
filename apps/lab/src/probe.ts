import type { SceneRenderer } from "@agentsim/ui";
import type { DockviewApi } from "dockview-react";

/**
 * Read-only test probe, installed only with `?probe` in the URL (e2e and benchmarks).
 * Exposes sampled render positions and stats; never any control or storage access.
 */
export interface LabProbe {
  /** [frameTimeMs, x of entity 0] per rendered frame (bounded). */
  frames: [number, number][];
  /** [frameTimeMs, frame work ms, atlas chunks pending] per rendered frame (bounded). */
  /** Per frame: time, work (ms), ground-truth chunks still queued, belief-overlay chunks still queued. */
  frameLog: [number, number, number, number][];
  frameWorkMs: () => { mean: number; p95: number; count: number };
  frameIntervalMs: () => { mean: number; p95: number };
  sim: () => unknown;
  stateLatencyMs: () => { mean: number; p95: number };
  loadMarks: Record<string, number>;
  /** Scene diagnostics (read-only): atlas pages and chunk uploads, path vertex counts, screen positions. */
  scene?: {
    stats: () => { pages: number; chunksUploaded: number; chunksPending: number; belief: { pages: number; chunksUploaded: number; chunksPending: number } };
    /** Believed state of a cell as drawn by the belief overlay (0 unknown, 1 free, 2 occupied). */
    beliefCell: (i: number, j: number) => number | undefined;
    /** What the ray, region and frontier overlays draw now. */
    overlays: () => ReturnType<SceneRenderer["overlayCounts"]>;
    paths: (agentId: string) => { planned: number; executed: number };
    screenOf: (agentId: string) => { x: number; y: number } | undefined;
    screenOfGround: (xM: number, yM: number) => { x: number; y: number };
    /** Cell values as drawn (the atlas CPU copy). */
    cell: (i: number, j: number) => { occupancy: number; terrainCost: number; heightDm: number; loaded: boolean } | undefined;
  };
  /** Executed path of an agent as received from the worker: flat (x, y, z) per point (a copy). */
  executedPath?: (agentId: string) => readonly number[];
  /** The run's trace records as received from the worker (read-only; capped by the client). */
  records?: () => readonly unknown[];
  /** The dock of the open workspace, read-only: each panel with its title, where it is and its state. */
  dock?: () => { id: string; title: string; location: string; maximized: boolean; collapsed: boolean; active: boolean; height: number }[];
  /** The shared UI context's selection (read-only). */
  selection?: () => { kind: string; id: string } | undefined;
  /**
   * A fixture for the review captures of the System 2 minds' states (F4): puts the state the designer's LimitsPause draws in the store the player, the status bar and the notice read, as the worker's `minds`
   * message would. It changes nothing in any run.
   */
  mindsFixture?: (state: "quiet" | "waiting" | "waiting-several" | "warning" | "paused" | "raised") => void;
  /**
   * For the tests of F4 (a run whose mind is a language model, over a provider of Settings): saves a profile of the library for that provider and model, and starts the F2 discovery demo with it as the mind of its
   * `scout` agent. Nothing but the run and the profile is changed; no key is read or passed here (it is in the provider store, where Settings put it).
   */
  startMindsRun?: (o: { provider: string; model: string; mission?: string; limits?: { calls?: number; tokens?: number } }) => Promise<void>;
  /** Wall ms of each draw of a top-down map (the Scene's 2D tab, the Analysis workspace), newest last; written by the map, cleared by the bench. */
  map2dMs?: number[];
}

declare global {
  interface Window {
    __agentsim?: LabProbe;
  }
}

export const probeEnabled = (): boolean => new URLSearchParams(location.search).has("probe");

/**
 * Points the probe at a renderer, or (with `undefined`, when a renderer is disposed) clears the scene handle so
 * tests wait for the next renderer instead of reading a disposed one after a workspace switch. Workspaces
 * unmount before the next mounts, so a clear never removes the new renderer.
 */
export function attachRendererProbe(r: SceneRenderer | undefined): void {
  const p = window.__agentsim;
  if (!p) return;
  if (!r) {
    delete p.scene;
    return;
  }
  p.frameWorkMs = () => ({ mean: r.frameWorkMs.mean(), p95: r.frameWorkMs.percentile(0.95), count: r.frameWorkMs.count });
  p.frameIntervalMs = () => ({ mean: r.frameIntervalMs.mean(), p95: r.frameIntervalMs.percentile(0.95) });
  r.onFrame = (poses, t, workMs) => {
    if (p.frames.length >= 2000) p.frames.shift();
    p.frames.push([t, poses[0] ?? Number.NaN]);
    // Per-frame work and atlas chunks still queued: benchmarks split the initial upload from steady frames.
    if (p.frameLog.length >= 6000) p.frameLog.shift();
    const st = r.stats();
    p.frameLog.push([t, workMs, st.chunksPending, st.belief.chunksPending]);
  };
  p.scene = {
    stats: () => r.stats(),
    paths: (id) => r.pathCounts(id),
    screenOf: (id) => r.screenOf(id),
    screenOfGround: (x, y) => r.screenOfGround(x, y),
    cell: (i, j) => r.cell(i, j),
    beliefCell: (i, j) => r.beliefCell(i, j),
    overlays: () => r.overlayCounts(),
  };
}

let workspaceMarked = false;

/** Marks the first workspace becoming visible (dockview is loaded after first paint, issue #4). */
export function markWorkspaceVisible(): void {
  if (workspaceMarked) return;
  workspaceMarked = true;
  performance.mark("agentsim:workspace-visible");
  if (window.__agentsim) window.__agentsim.loadMarks["workspaceVisible"] = performance.now();
}

/** Points the probe at the dock of the open workspace (cleared when it goes). */
export function attachDockProbe(api: DockviewApi | undefined, collapsed: (groupHeight: number, floating: boolean) => boolean): void {
  const p = window.__agentsim;
  if (!p) return;
  if (!api) {
    delete p.dock;
    return;
  }
  p.dock = () =>
    api.panels.map((panel) => ({
      id: panel.id,
      title: panel.title ?? panel.id,
      location: panel.api.location.type,
      maximized: panel.api.isMaximized(),
      collapsed: collapsed(panel.group.height, panel.api.location.type === "floating"),
      active: api.activePanel?.id === panel.id,
      height: panel.group.height,
    }));
}
