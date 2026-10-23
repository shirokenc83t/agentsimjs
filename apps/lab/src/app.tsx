import type { StorageInfo } from "@agentsim/storage";
import type { DockviewApi } from "dockview-react";
import { Banner, CommandPalette, downloadBytes, THEME_PREFERENCES, useUiContext, type Command } from "@agentsim/ui";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyAppearance, loadAppearance } from "./config/appearance.ts";
import { AppActionsProvider, CurrentRunProvider, usePolled, useServices, useStorageStatus, useThemeSetting, type CurrentRun } from "./services.tsx";
import type { PresetId } from "@agentsim/core";
import { applyPreset, closePanel, dockPanel, floatPanel, focusNext, focusNumber, isFloating, openPanel, syncCollapsed, toggleCollapse, toggleMaximize } from "./workspaces/dock-actions.ts";
import { deleteNamedLayout, layoutName, listNamedLayouts, readNamedLayout, saveNamedLayout } from "./workspaces/layouts.ts";
import { BUILTIN_LAYOUTS, DEBUG_LOGS_LAYOUT, LAYOUT_NAMESPACE, layoutKey, WORKSPACES, type WorkspaceId } from "./workspaces/presets.ts";
import { PANELS, type PanelId } from "./workspaces/registry.tsx";
import { LazyReplayHost, LazyRunPopover, LazyWorkspaceHost, loadAgentCommands, loadResimController, loadRunController } from "./workspaces/registry.tsx";
import { Player } from "./shell/player.tsx";
import { shellKey } from "./shell/shortcuts.ts";
import { StatusBar } from "./shell/status-bar.tsx";
import { TopBar } from "./shell/top-bar.tsx";
import "./shell/shell.css";
import type { LabRun } from "./sim/run-controller.ts";

/** Lab shell (UI-SPEC §2): top bar, player, banners, workspace, status bar, command palette. */
export function App() {
  const { sim, source, storage } = useServices();
  const status = useStorageStatus(storage);
  const setTheme = useThemeSetting(storage);
  // The appearance preferences saved in user data, once storage is ready.
  useEffect(() => {
    if (status.state === "ready") void loadAppearance(storage.ports.userData).then(applyAppearance, () => {});
  }, [status.state, storage]);
  const snap = usePolled(useCallback(() => sim.snapshot(), [sim]), 100);
  // What the panels show (the live run, or a recording read from storage): the player is its time control.
  const view = usePolled(useCallback(() => source?.snapshot(), [source]), 100);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceId>("scene");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  // The dock of the open workspace (it is built after first paint and again when the workspace changes) and its named layouts.
  const dockRef = useRef<DockviewApi | null>(null);
  const presetRef = useRef<(typeof WORKSPACES)[number] | undefined>(undefined);
  const [layouts, setLayouts] = useState<string[]>([]);
  const [activeLayout, setActiveLayout] = useState<string | undefined>(undefined);
  // A layout that ships with the app, when one is open (the Debug's "debug · logs"): the dock as it was is kept here to put it back, and the autosave of the working layout waits.
  const [builtinActive, setBuiltinActive] = useState<string | undefined>(undefined);
  const stash = useRef<unknown>(undefined);
  const autosave = useRef(true);
  const workspaceRef = useRef<WorkspaceId>("scene");
  const builtinRef = useRef<string | undefined>(undefined);
  const enterLogsRef = useRef<() => void>(() => {});
  const [run, setRun] = useState<LabRun | undefined>(undefined);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runAnchor, setRunAnchor] = useState<HTMLElement | null>(null);
  // A replay session: the run being shown from storage (the session itself, and what it says when it cannot open, are in its lazy chunk).
  const [replayRun, setReplayRun] = useState<string | undefined>(undefined);
  // What the last "Re-simulate window" said: its verdict, or why it could not be done. Dismissed by the researcher.
  const [resimNote, setResimNote] = useState<{ kind: "info" | "warn" | "danger"; text: string; open?: string } | null>(null);

  const startRun = useCallback(
    (start: () => Promise<LabRun>) => {
      setReplayRun(undefined); // a run that starts is what the panels show
      setRunBusy(true);
      setRunError(null);
      start().then(
        (r) => {
          setRun(r);
          setRunBusy(false);
        },
        (e: unknown) => {
          setRunError(e instanceof Error ? e.message : String(e));
          setRunBusy(false);
        },
      );
    },
    [],
  );
  const loadDemo = useCallback(() => startRun(async () => (await loadRunController()).startDemoRun(storage, sim)), [startRun, storage, sim]);
  const startPreset = useCallback((p: PresetId) => startRun(async () => (await loadRunController()).startPresetRun(storage, sim, p)), [startRun, storage, sim]);
  const loadReference = useCallback(
    () => startRun(async () => (await loadRunController()).startPresetRun(storage, sim, "f1-reference-1km")),
    [startRun, storage, sim],
  );
  const listRuns = useCallback(async () => (await loadRunController()).resimulatableRuns(storage), [storage]);
  const resimulate = useCallback((runId: string) => startRun(async () => (await loadRunController()).resimulateRun(storage, sim, runId)), [startRun, storage, sim]);
  const rerunCurrent = useCallback(() => run && startRun(async () => (await loadRunController()).rerun(storage, sim, run)), [startRun, storage, sim, run]);
  const rerunInMode = useCallback(
    (mode: "lockstep" | "realtime") => run && startRun(async () => (await loadRunController()).rerunInMode(storage, sim, run, mode)),
    [startRun, storage, sim, run],
  );
  const otherMode = snap.mode === "realtime" ? "lockstep" : "realtime";
  const runWithConfig = useCallback(
    (runConfig: unknown) => run && startRun(async () => (await loadRunController()).startRun(storage, sim, run.scenario, run.loaded.scenarioVersion, runConfig, run.header.label)),
    [startRun, storage, sim, run],
  );
  const startScenarioRun = useCallback(
    (scenario: unknown, version: number, runConfig: unknown, label: string) =>
      startRun(async () => (await loadRunController()).startRun(storage, sim, scenario, version, runConfig, label)),
    [startRun, storage, sim],
  );
  const currentRun = useMemo<CurrentRun>(
    () => ({ run, busy: runBusy || status.state !== "ready", error: runError, loadDemo, runWithConfig: (c) => void runWithConfig(c), startScenarioRun }),
    [run, runBusy, status.state, runError, loadDemo, runWithConfig, startScenarioRun],
  );

  // Refresh storage info at 0.5 Hz while ready (status line).
  useEffect(() => {
    if (status.state !== "ready") return;
    const tick = () => void storage.admin.info().then(setInfo, () => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [status, storage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      // Alt+number: the panel with that number in the open workspace (the number is in its tab).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code) && dockRef.current && presetRef.current) {
        e.preventDefault();
        // In the Debug the sixth is the Logs: it is a layout of its own, not a panel of the dock.
        if (e.code === "Digit6" && workspaceRef.current === "debug" && builtinRef.current === undefined) enterLogsRef.current();
        else focusNumber(dockRef.current, presetRef.current, Number(e.code.slice(5)));
        return;
      }
      const k = shellKey(e, e.target, WORKSPACES.length);
      if (!k) return;
      e.preventDefault();
      if (k.kind === "workspace") setWorkspace((WORKSPACES[k.index] as (typeof WORKSPACES)[number]).id);
      else if (k.kind === "step") sim.step();
      else if (sim.snapshot().running) sim.pause();
      else sim.play();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sim]);

  const resetLayouts = useCallback(() => {
    if (storage.status().state === "ready") for (const w of WORKSPACES) void storage.ports.userData.delete(LAYOUT_NAMESPACE, layoutKey(w.id));
    autosave.current = true;
    stash.current = undefined;
    setBuiltinActive(undefined);
    setActiveLayout(undefined);
    setLayoutEpoch((n) => n + 1);
  }, [storage]);

  // Named layouts of the open workspace: listed when it opens (and once storage is ready), saved, loaded and deleted from the top bar.
  const storageReady = status.state === "ready";
  useEffect(() => {
    setActiveLayout(undefined);
    // Another workspace is a dock of its own: what a layout of the last one held is gone with it.
    autosave.current = true;
    stash.current = undefined;
    setBuiltinActive(undefined);
    if (storageReady) void listNamedLayouts(storage, workspace).then(setLayouts, () => setLayouts([]));
    else setLayouts([]);
  }, [storage, storageReady, workspace]);
  const builtins = BUILTIN_LAYOUTS[workspace] ?? [];
  /** Opens a layout that ships with the app: the dock is kept as it is, and laid out again as the layout says. */
  const enterBuiltin = useCallback(
    (name: string) => {
      const api = dockRef.current;
      const b = (BUILTIN_LAYOUTS[workspace] ?? []).find((x) => x.name === name);
      if (!api || !b || builtinRef.current !== undefined) return;
      stash.current = api.toJSON();
      if (storageReady) void storage.ports.userData.set(LAYOUT_NAMESPACE, layoutKey(workspace), stash.current);
      autosave.current = false;
      applyPreset(api, b.preset);
      setBuiltinActive(name);
      setActiveLayout(name);
    },
    [storage, storageReady, workspace],
  );
  /** Puts the dock back as it was before the layout that ships with the app was opened. */
  const leaveBuiltin = useCallback(() => {
    const api = dockRef.current;
    if (!api || builtinRef.current === undefined) return;
    autosave.current = true;
    const kept = stash.current;
    stash.current = undefined;
    try {
      if (kept === undefined) throw new Error("nothing kept");
      api.fromJSON(kept as Parameters<DockviewApi["fromJSON"]>[0]);
      syncCollapsed(api);
    } catch {
      const base = WORKSPACES.find((w) => w.id === workspaceRef.current);
      if (base) applyPreset(api, base);
    }
    setBuiltinActive(undefined);
    setActiveLayout(undefined);
  }, []);
  enterLogsRef.current = () => enterBuiltin(DEBUG_LOGS_LAYOUT);
  const saveLayout = useCallback(
    (raw: string) => {
      const name = layoutName(raw);
      const api = dockRef.current;
      if (!name || !api || !storageReady || builtins.some((b) => b.name === name) || builtinRef.current !== undefined) return;
      void saveNamedLayout(storage, workspace, name, api.toJSON())
        .then(() => listNamedLayouts(storage, workspace))
        .then((l) => {
          setLayouts(l);
          setActiveLayout(name);
        });
    },
    [storage, storageReady, workspace, builtins],
  );
  const selectLayout = useCallback(
    (name: string | undefined) => {
      const api = dockRef.current;
      if (name !== undefined && (BUILTIN_LAYOUTS[workspace] ?? []).some((b) => b.name === name)) return enterBuiltin(name);
      if (builtinRef.current !== undefined) {
        // From a layout that ships with the app to the working layout or a named one: the dock is put back first (the working layout), a named one then replaces it.
        leaveBuiltin();
        if (name === undefined) return;
      }
      if (name === undefined || !api || !storageReady) {
        setActiveLayout(undefined);
        return;
      }
      void readNamedLayout(storage, workspace, name).then((saved) => {
        if (!saved || dockRef.current !== api) return;
        try {
          api.fromJSON(saved as Parameters<DockviewApi["fromJSON"]>[0]);
          syncCollapsed(api);
          setActiveLayout(name);
        } catch {
          // A layout that does not fit the panels any more is left as it is.
        }
      });
    },
    [storage, storageReady, workspace, enterBuiltin, leaveBuiltin],
  );
  const deleteLayout = useCallback(() => {
    if (!activeLayout || !storageReady || builtinRef.current !== undefined) return;
    const name = activeLayout;
    void deleteNamedLayout(storage, workspace, name)
      .then(() => listNamedLayouts(storage, workspace))
      .then((l) => {
        setLayouts(l);
        setActiveLayout(undefined);
      });
  }, [storage, storageReady, workspace, activeLayout]);

  const ready = status.state === "ready";
  // Researcher commands on the selected agent come from a lazy module (nothing in the initial chunk), fetched when the
  // palette first opens. The entries are built in the render that opens it, from the selection at that moment (it cannot
  // change while the palette is open), and dropped when it closes: an entry list built in an effect lagged one render
  // behind and could run a command on the previously selected agent.
  const [agentCommandsModule, setAgentCommandsModule] = useState<Awaited<ReturnType<typeof loadAgentCommands>>>();
  useEffect(() => {
    if (paletteOpen && !agentCommandsModule) void loadAgentCommands().then(setAgentCommandsModule);
  }, [paletteOpen, agentCommandsModule]);
  const agentCommands = useMemo<Command[]>(
    () => (paletteOpen && agentCommandsModule && source ? agentCommandsModule.agentPaletteCommands(source, !!run, startPreset, runBusy) : []),
    [paletteOpen, agentCommandsModule, source, run, startPreset, runBusy],
  );
  const basePreset = WORKSPACES.find((w) => w.id === workspace) ?? WORKSPACES[0];
  // The preset the dock is laid out by now: the workspace's, or that of the layout that ships with the app which is open (its panels, its numbers).
  const preset = (builtinActive === undefined ? undefined : builtins.find((b) => b.name === builtinActive)?.preset) ?? basePreset;
  presetRef.current = preset;
  workspaceRef.current = workspace;
  builtinRef.current = builtinActive;
  // Panel actions of the open workspace's dock, on the active panel (ADR-0042 §7): the window buttons' actions, from the palette.
  const panelCommands = useMemo<Command[]>(() => {
    const on = (f: (api: DockviewApi, panel: NonNullable<ReturnType<DockviewApi["getPanel"]>>) => void) => () => {
      const api = dockRef.current;
      const panel = api?.activePanel;
      if (api && panel) f(api, panel);
    };
    return [
      { id: "panel.float", title: "Float the active panel", group: "Panel", run: on((api, p) => (isFloating(p) ? undefined : floatPanel(api, p))) },
      { id: "panel.dock", title: "Dock the active panel", group: "Panel", run: on((api, p) => void dockPanel(api, p, preset)) },
      { id: "panel.maximize", title: "Maximize or restore the active panel", group: "Panel", run: on((api, p) => toggleMaximize(api, p)) },
      { id: "panel.collapse", title: "Collapse or open the active floating window", group: "Panel", run: on((_api, p) => toggleCollapse(p.group)) },
      { id: "panel.close", title: "Close the active panel", group: "Panel", run: on((_api, p) => closePanel(p)) },
      { id: "panel.next", title: "Focus the next panel", group: "Panel", run: () => dockRef.current && focusNext(dockRef.current) },
      ...(preset?.panels ?? []).map((p) => ({ id: `panel.open.${p.id}`, title: `Open panel: ${PANELS[p.id as PanelId].title}`, group: "Panel", run: () => dockRef.current && preset && openPanel(dockRef.current, preset, p.id) })),
      // The Logs are a layout of the Debug, not a panel of its dock (UI-SPEC: "debug · logs"): one command to go there and one to come back.
      ...(workspace === "debug" && builtinActive === undefined ? [{ id: "panel.open.logInspector", title: `Open panel: ${PANELS.logInspector.title}`, group: "Panel", keys: "Alt+6", run: () => enterBuiltin(DEBUG_LOGS_LAYOUT) }] : []),
      ...(builtinActive !== undefined ? [{ id: "layout.back", title: "Back to debug", group: "Layout", run: leaveBuiltin }] : []),
    ];
  }, [preset, workspace, builtinActive, enterBuiltin, leaveBuiltin]);
  // Re-simulates a window of the run the panels show into a derived run, stored with its verdict (ADR-0035 section 3): the Timeline's selection when there is one, else the
  // cursor with a few seconds either side. The derived run opens in the panels from the notice (it carries the parent's configuration records, so replay can build it).
  const resimulateWindow = useCallback(async () => {
    const runId = view?.runId;
    if (!runId || storage.status().state !== "ready") return;
    setResimNote({ kind: "info", text: `Re-simulating a window of ${runId}…` });
    try {
      const c = await loadResimController();
      const picked = useUiContext.getState().timeSelection;
      const w = picked !== undefined ? ({ ok: true, value: picked } as const) : await c.suggestWindow(storage.ports, runId, useUiContext.getState().simTime);
      if (!w.ok) return setResimNote({ kind: "warn", text: `Cannot re-simulate a window of ${runId}: ${w.error.message}` });
      const r = await c.resimulateWindowToRun(storage.ports, runId, w.value);
      if (!r.ok) return setResimNote({ kind: "danger", text: `Could not re-simulate a window of ${runId}: ${r.error.message}` });
      const d = r.value.derived;
      setResimNote(
        d.status === "matches"
          ? { kind: "info", text: `Window ${d.t0S}–${d.t1S} s of ${runId} re-simulated as ${r.value.runId}: it matches (${d.checkpointsChecked} checkpoints reproduced).`, open: r.value.runId }
          : { kind: "danger", text: `Window ${d.t0S}–${d.t1S} s of ${runId} re-simulated as ${r.value.runId}: DIVERGENT at tick ${d.divergence?.tick ?? "?"} (the state hash differs from the recorded one).`, open: r.value.runId },
      );
    } catch (e) {
      setResimNote({ kind: "danger", text: `Could not re-simulate a window: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [view?.runId, storage]);
  // The Performance window is in the Scene and the Debug; elsewhere it opens from here (the status bar's frame segment, the palette).
  const openPerformance = useCallback(() => {
    if (dockRef.current && presetRef.current) openPanel(dockRef.current, presetRef.current, "perf");
  }, []);
  const commands = useMemo<Command[]>(
    () => [
      ...WORKSPACES.map((w, i) => ({ id: `ws.${w.id}`, title: `Switch to ${w.title} workspace`, group: "Workspace", keys: String(i + 1), run: () => setWorkspace(w.id) })),
      { id: "sim.toggle", title: "Play / pause", group: "Run", keys: "Space", run: () => (sim.snapshot().running ? sim.pause() : sim.play()) },
      { id: "sim.step", title: "Step one tick", group: "Run", keys: ".", run: () => sim.step() },
      { id: "sim.step10", title: "Step 10 ticks", group: "Run", run: () => sim.step(10) },
      { id: "sim.step100", title: "Step 100 ticks", group: "Run", run: () => sim.step(100) },
      { id: "run.demo", title: "Load F1 demo scenario (new run)", group: "Run", disabled: !ready || runBusy, run: loadDemo },
      {
        id: "run.reference",
        title: "Load 1 km² reference world (new run)",
        group: "Run",
        disabled: !ready || runBusy,
        run: loadReference,
      },
      ...agentCommands,
      { id: "run.config", title: "Open run configuration", group: "Run", run: () => setWorkspace("author") },
      { id: "run.resimWindow", title: "Re-simulate window…", group: "Run", disabled: !ready || !view?.runId, run: () => void resimulateWindow() },
      { id: "run.rerun", title: "Re-run (same scenario version and run configuration)", group: "Run", disabled: !ready || runBusy || !run, run: () => rerunCurrent() },
      {
        id: "run.rerunMode",
        title: `Re-run in ${otherMode} (new run, time mode changed)`,
        group: "Run",
        disabled: !ready || runBusy || !run,
        run: () => rerunInMode(otherMode),
      },
      {
        id: "db.export", title: "Export database (.sqlite)", group: "Storage", disabled: !ready,
        run: () => void storage.admin.exportDb().then((b) => downloadBytes(b, "agentsim.sqlite")),
      },
      { id: "db.browser", title: "Open Storage browser", group: "Storage", run: () => setWorkspace("data") },
      { id: "layout.reset", title: "Reset workspace layouts", group: "Layout", run: resetLayouts },
      ...THEME_PREFERENCES.map((t) => ({ id: `theme.${t}`, title: `Theme: ${t}`, group: "Theme", run: () => setTheme(t) })),
      { id: "panel.perf", title: "Open the Performance window", group: "Panel", run: openPerformance },
      ...panelCommands,
    ],
    [ready, sim, storage, resetLayouts, setTheme, openPerformance, resimulateWindow, view?.runId, loadDemo, loadReference, rerunCurrent, rerunInMode, otherMode, runBusy, run, agentCommands, panelCommands],
  );

  return (
    <AppActionsProvider value={{ resetLayouts, setTheme, openWorkspace: setWorkspace, openReplay: setReplayRun, resimulateWindow: () => void resimulateWindow(), backToDebug: leaveBuiltin }}>
      <CurrentRunProvider value={currentRun}>
      <div className="shell">
        <div data-testid="shell-header">
          <TopBar
            workspaces={WORKSPACES}
            workspace={workspace}
            onWorkspace={setWorkspace}
            layouts={[...builtins.map((b) => b.name), ...layouts]}
            layoutActive={activeLayout}
            layoutBuiltin={builtinActive !== undefined}
            onSelectLayout={selectLayout}
            onSaveLayout={saveLayout}
            onDeleteLayout={deleteLayout}
            onResetLayout={resetLayouts}
            runLabel={run ? `${run.header.runId} · ${run.header.scenarioId ?? "?"} v${run.header.scenarioVersion ?? "?"}` : "run: —"}
            runOpen={runAnchor !== null}
            onRunClick={setRunAnchor}
            replaying={view?.mode === "replay"}
            derived={view?.replay?.derived}
            onPalette={() => setPaletteOpen(true)}
          >
            {runAnchor && (
              <Suspense fallback={null}>
                <LazyRunPopover
                  anchor={runAnchor}
                  onClose={() => setRunAnchor(null)}
                  run={run}
                  snap={snap}
                  busy={runBusy || !ready}
                  error={runError}
                  onLoadDemo={loadDemo}
                  onLoadReference={loadReference}
                  onRerun={() => rerunCurrent()}
                  listRuns={listRuns}
                  onResimulate={resimulate}
                  onReplay={(runId) => {
                    setReplayRun(runId);
                    setRunAnchor(null);
                  }}
                />
              </Suspense>
            )}
          </TopBar>
          <Player
            sim={sim}
            snap={snap}
            view={view}
            compact={workspace === "author" || workspace === "data" || workspace === "settings"}
            recorded={run?.header.recording === "stored"}
            busy={runBusy}
            onRerunInMode={(mode) => run && rerunInMode(mode)}
            onScrubBack={setReplayRun}
            onBackToLive={() => setReplayRun(undefined)}
          />
        </div>

        <div>
          {replayRun !== undefined && (
            <Suspense fallback={null}>
              <LazyReplayHost runId={replayRun} />
            </Suspense>
          )}
          {status.state === "waiting-lock" && (
            <Banner kind="info" testId="db-in-use">
              Database in use in another tab. Storage is paused here and opens automatically when that tab is closed.
            </Banner>
          )}
          {status.state === "ready" && status.mode === "memory-fallback" && (
            <Banner kind="warn" testId="not-persistent">
              Storage is not persistent — export before closing. ({status.warning ?? "OPFS unavailable"})
            </Banner>
          )}
          {status.state === "failed" && (
            <Banner kind="danger" testId="storage-failed">Storage failed to open: {status.error}</Banner>
          )}
          {resimNote && (
            <Banner kind={resimNote.kind} testId="resim-notice">
              {resimNote.text}{" "}
              {resimNote.open !== undefined && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setReplayRun(resimNote.open);
                    setResimNote(null);
                  }}
                  data-testid="resim-notice-open"
                >
                  Open derived run
                </button>
              )}{" "}
              <button type="button" className="btn" onClick={() => setResimNote(null)} data-testid="resim-notice-dismiss">
                Dismiss
              </button>
            </Banner>
          )}
        </div>

        {/* The row is reserved by the shell grid, so nothing shifts when the workspace chunk arrives. */}
        <div className="workspace">
          <Suspense fallback={null}>{basePreset && preset && <LazyWorkspaceHost key={basePreset.id} preset={basePreset} activePreset={preset} autosave={autosave} storage={storage} layoutEpoch={layoutEpoch} onApi={(api) => (dockRef.current = api)} />}</Suspense>
        </div>

        <StatusBar snap={snap} status={status} info={info} header={run?.header} replaying={view?.mode === "replay"} onOpenPerf={openPerformance} />

        <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      </div>
      </CurrentRunProvider>
    </AppActionsProvider>
  );
}

