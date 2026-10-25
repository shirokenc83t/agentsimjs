import type { StorageClient, StorageStatus } from "@agentsim/storage";
import { isThemePreference, setThemePreference, type ThemePreference } from "@agentsim/ui";
import { createContext, useContext, useEffect, useState } from "react";
import type { LabRun } from "./sim/run-controller.ts";
import type { WorkspaceId } from "./workspaces/presets.ts";
import type { PanelId } from "./workspaces/registry.tsx";
import type { RunSource } from "./sim/run-source.ts";
import type { SimClient } from "./sim/sim-client.ts";

/** App services shared by panels (constructed once in the composition root). */
export interface Services {
  /** The run in the sim worker, for what controls it: play, pause, step, load, presets (live only). */
  readonly sim: SimClient;
  /** The run as panels read it: live, or a recorded run in replay (ADR-0016). Panels read this, never the client. Undefined for the moment the live source loads. */
  readonly source: RunSource | undefined;
  /** Puts a recorded run in place of the live one for the panels (a replay session), or the live one back (`undefined`). */
  readonly setReplaySource: (s: RunSource | undefined) => void;
  readonly storage: StorageClient;
}

const ServicesContext = createContext<Services | null>(null);

export const ServicesProvider = ServicesContext.Provider;

/** The run source, in the panels (they mount once it is there: the workspace waits for it). */
export function useSource(): RunSource {
  const s = useServices().source;
  if (!s) throw new Error("the run source is not ready");
  return s;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("useServices() outside ServicesProvider");
  return s;
}

/** App-level actions panels may trigger (dockview owns panel props, so these travel by context). */
export interface AppActions {
  resetLayouts(): void;
  /** Theme preference: applied at once, stored in `user_data` and mirrored for first paint (ADR-0032 §2). */
  setTheme(p: ThemePreference): void;
  /** Switches workspace (e.g. to the Scene after starting a run from the editor). */
  openWorkspace(id: WorkspaceId): void;
  /** Shows a recorded run from storage in the panels (nothing goes to the sim worker); `undefined` goes back to the live run. */
  openReplay(runId: string | undefined): void;
  /** Re-simulates a window of the run shown into a derived run: the Timeline's selection when there is one, else the cursor with a few seconds either side. */
  resimulateWindow(): void;
  /** Leaves the Debug's "debug · logs" layout and puts the dock back as it was. */
  backToDebug(): void;
  /** Opens a window of the open workspace's dock that is in no preset or was closed (the trace graph from the Trace panel): where the preset has it, or as a floating window. */
  openPanel(id: PanelId): void;
  /** The layout that ships with the open workspace that is on (its name; the first when none was chosen), and a way to put another on: the Log's `1 col | 2 col` switch. */
  layoutVariant?: string | undefined;
  selectLayout?(name: string): void;
}
const AppActionsContext = createContext<AppActions>({ resetLayouts: () => {}, setTheme: () => {}, openWorkspace: () => {}, openReplay: () => {}, resimulateWindow: () => {}, backToDebug: () => {}, openPanel: () => {} });
export const AppActionsProvider = AppActionsContext.Provider;
export const useAppActions = (): AppActions => useContext(AppActionsContext);

/** The current run as panels see it, and the run starts they may request (the shell owns the run). */
export interface CurrentRun {
  readonly run: LabRun | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  /** How many commands the run shown has recorded: a headless run applies them again (the buttons say "re-run" when there are some). */
  readonly rerunCommands?: number;
  loadDemo(): void;
  /** A new run of the current run's scenario version with another run configuration (new ID, new header). */
  runWithConfig(runConfig: unknown): void;
  /** A new headless run (ADR-0029) of the current run's scenario version with another run configuration: lockstep, always recorded, for the duration chosen. */
  runHeadlessWithConfig(runConfig: unknown): void;
  /** A new run of a stored scenario version (scenario editor "Run"); the documents are validated by the worker. */
  startScenarioRun(scenario: unknown, scenarioVersion: number, runConfig: unknown, label: string): void;
}
const CurrentRunContext = createContext<CurrentRun>({
  run: undefined,
  busy: false,
  error: null,
  rerunCommands: 0,
  loadDemo: () => {},
  runWithConfig: () => {},
  runHeadlessWithConfig: () => {},
  startScenarioRun: () => {},
});
export const CurrentRunProvider = CurrentRunContext.Provider;
export const useCurrentRun = (): CurrentRun => useContext(CurrentRunContext);

/** Storage status as React state (status events are rare; no throttling needed). */
export function useStorageStatus(storage: StorageClient): StorageStatus {
  const [status, setStatus] = useState<StorageStatus>(storage.status());
  useEffect(() => storage.onStatus(setStatus), [storage]);
  return status;
}

/** Polls `read` at a UI rate. 100 ms is the clamp floor (10 Hz ceiling, ADR-0016), not a target. */
export function usePolled<T>(read: () => T, intervalMs = 200): T {
  const [v, setV] = useState<T>(read);
  useEffect(() => {
    const t = setInterval(() => setV(read()), Math.max(100, intervalMs));
    return () => clearInterval(t);
  }, [read, intervalMs]);
  return v;
}

/** `user_data` key of the theme preference (ADR-0032 §2): the source of truth; localStorage is only a mirror. */
export const THEME_SETTING = { namespace: "ui", key: "theme" } as const;

/**
 * Keeps the theme in line with `user_data` (ADR-0032 §2): once storage is ready, the stored preference
 * wins over the boot-time mirror (which `setThemePreference` refreshes). Returns the setter used by Settings,
 * which writes both. Theme changes never touch the simulation.
 */
export function useThemeSetting(storage: StorageClient): (p: ThemePreference) => void {
  const status = useStorageStatus(storage);
  useEffect(() => {
    if (status.state !== "ready") return;
    let alive = true;
    void storage.ports.userData.get(THEME_SETTING.namespace, THEME_SETTING.key).then(
      (v) => {
        if (alive && isThemePreference(v)) setThemePreference(v);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [status, storage]);
  return (p: ThemePreference) => {
    setThemePreference(p);
    if (storage.status().state === "ready") void storage.ports.userData.set(THEME_SETTING.namespace, THEME_SETTING.key, p);
  };
}

