import "./fonts.css";
import "@agentsim/ui/theme.css";
import { initTheme, UiThemeProvider, useUiContext } from "@agentsim/ui";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { applyAppearance, readAppearance } from "./config/appearance.ts";
import { connectRecorder, resolveEnvironment } from "./config/environment.ts";
import { probeEnabled } from "./probe.ts";
import type { RunSource } from "./sim/run-source.ts";
import { ServicesProvider } from "./services.tsx";
import { loadLiveSource } from "./workspaces/registry.tsx";

// TypeBox is configured lazily, by the first validate()/isValid() call (ADR-0018 addition 2026-10-08): keeping
// it out of the entry keeps the checker out of the initial chunk. Lint allows the checker only in that wrapper.

// Theme before first render, from the localStorage mirror of ui.theme (ADR-0032 §2); no inline script (§10).
initTheme();
applyAppearance(readAppearance());

const env = resolveEnvironment(import.meta.env["VITE_AGENTSIM_ENV"] as string | undefined);
const storage = env.createStorage();
const sim = env.createSim(10);
connectRecorder(sim, storage);

/** The panels' run source: the live run, or a recorded run while a replay session is open. */
function Root() {
  const [replay, setReplay] = useState<RunSource | undefined>(undefined);
  const [live, setLive] = useState<RunSource | undefined>(undefined);
  useEffect(() => void loadLiveSource().then((m) => setLive(new m.LiveRunSource(sim, storage))), []);
  return (
    <ServicesProvider value={{ sim, source: replay ?? live, setReplaySource: setReplay, storage }}>
      <App />
    </ServicesProvider>
  );
}

if (probeEnabled()) {
  window.__agentsim = {
    frames: [],
    frameLog: [],
    frameWorkMs: () => ({ mean: 0, p95: 0, count: 0 }),
    frameIntervalMs: () => ({ mean: 0, p95: 0 }),
    sim: () => sim.snapshot(),
    stateLatencyMs: () => ({ mean: sim.stateLatencyMs.mean(), p95: sim.stateLatencyMs.percentile(0.95) }),
    loadMarks: {},
    selection: () => useUiContext.getState().selection,
    executedPath: (id) => Array.from(sim.executedPath(id).points),
    records: () => sim.records(),
  };
}

// Initial load metric (reported, no threshold yet — ADR-0021): shell rendered + storage settled.
void storage.ready().then(
  () => markInteractive(),
  () => markInteractive(),
);
storage.onStatus((s) => {
  if (s.state === "waiting-lock") markInteractive();
});
let marked = false;
function markInteractive(): void {
  if (marked) return;
  marked = true;
  performance.mark("agentsim:interactive");
  if (window.__agentsim) window.__agentsim.loadMarks["interactive"] = performance.now();
}

void storage.ready().then(() => storage.admin.requestPersistence());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <UiThemeProvider>
      <Root />
    </UiThemeProvider>
  </StrictMode>,
);
