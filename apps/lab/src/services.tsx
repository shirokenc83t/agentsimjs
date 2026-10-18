import type { StorageClient, StorageStatus } from "@agentsim/storage";
import { isThemePreference, setThemePreference, type ThemePreference } from "@agentsim/ui";
import { createContext, useContext, useEffect, useState } from "react";
import type { LabRun } from "./sim/run-controller.ts";
import type { WorkspaceId } from "./workspaces/presets.ts";
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
}
const AppActionsContext = createContext<AppActions>({ resetLayouts: () => {}, setTheme: () => {}, openWorkspace: () => {}, openReplay: () => {} });
export const AppActionsProvider = AppActionsContext.Provider;
export const useAppActions = (): AppActions => useContext(AppActionsContext);

/** The current run as panels see it, and the run starts they may request (the shell owns the run). */
export interface CurrentRun {
  readonly run: LabRun | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  loadDemo(): void;
  /** A new run of the current run's scenario version with another run configuration (new ID, new header). */
  runWithConfig(runConfig: unknown): void;
  /** A new run of a stored scenario version (scenario editor "Run"); the documents are validated by the worker. */
  startScenarioRun(scenario: unknown, scenarioVersion: number, runConfig: unknown, label: string): void;
}
const CurrentRunContext = createContext<CurrentRun>({
  run: undefined,
  busy: false,
  error: null,
  loadDemo: () => {},
  runWithConfig: () => {},
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

