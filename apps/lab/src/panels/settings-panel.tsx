import "./panels.css";
import { formatBytes, isThemePreference, THEME_PREFERENCES, useTheme } from "@agentsim/ui";
import { useState } from "react";
import { readAppearance, applyAppearance, writeAppearance, type Appearance } from "../config/appearance.ts";
import { readQuotaThreshold, writeQuotaThreshold } from "../config/environment.ts";
import { useAppActions, useServices, useStorageStatus } from "../services.tsx";

const SECTIONS = [
  { id: "appearance", n: 1, title: "APPEARANCE" },
  { id: "providers", n: 2, title: "PROVIDERS AND KEYS" },
  { id: "storage", n: 3, title: "STORAGE" },
  { id: "layouts", n: 4, title: "LAYOUTS" },
  { id: "keyboard", n: 5, title: "KEYBOARD" },
] as const;

const KEYS: readonly (readonly [string, string])[] = [
  ["Space", "play or pause"],
  [".", "step one tick"],
  ["1 – 5", "open scene, debug, author, data, settings"],
  ["Ctrl+K", "command palette"],
  ["Alt+1 … 9", "focus the panel with that number"],
  ["↑ ↓ Home End", "move in the event list and the Explorer"],
  ["V B Z A O", "scenario editor tools: navigate, paint, zone, agent, object"],
  ["Ctrl+Z", "undo the last stroke in the scenario editor"],
];

const themeLabel = (p: string, resolved: string, preference: string) => (p === "system" ? `system (${preference === "system" ? resolved : "follows the OS"})` : p);

/** A switch as a labelled checkbox: the state is the track and the thumb, and the text says what it does. */
function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; testId: string; help?: string }) {
  return (
    <label className={`tog${props.checked ? " on" : ""}`}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} data-testid={props.testId} />
      <i aria-hidden="true" />
      <span>{props.label}</span>
      {props.help && <span className="muted"> · {props.help}</span>}
    </label>
  );
}

/** Settings workspace: appearance, providers and keys (none yet), storage threshold and persistence, layouts, keys. */
export function SettingsPanel() {
  const { storage } = useServices();
  const { resetLayouts, setTheme } = useAppActions();
  const theme = useTheme();
  const status = useStorageStatus(storage);
  const [thresholdMb, setThresholdMb] = useState(() => Math.round(readQuotaThreshold() / (1024 * 1024)));
  const [persistMsg, setPersistMsg] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("appearance");
  const set = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    writeAppearance(next);
    applyAppearance(next);
  };
  const goTo = (id: (typeof SECTIONS)[number]["id"]) => {
    setSection(id);
    document.querySelector(`[data-section="${id}"]`)?.scrollIntoView?.({ block: "start" });
  };

  return (
    <div className="panel settings rc" data-testid="settings-panel">
      <div className="st-body">
        <nav className="rc-rail" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`nv${section === s.id ? " on" : ""}`} aria-current={section === s.id ? "true" : undefined} onClick={() => goTo(s.id)}>
              <span className="n">{s.n}</span>
              {s.title}
            </button>
          ))}
        </nav>
        <div className="rc-form">
          <section className="fs" data-section="appearance">
            <h4 className="sec">
              <b>1 · APPEARANCE</b>
              <span className="rule" />
            </h4>
            <div className="st-row">
              <span className="rc-label">theme</span>
              <span className="segc" role="radiogroup" aria-label="Theme">
                {THEME_PREFERENCES.map((p) => (
                  <label key={p} className={theme.preference === p ? "on" : undefined}>
                    <input type="radio" name="theme" value={p} checked={theme.preference === p} onChange={(e) => isThemePreference(e.target.value) && setTheme(e.target.value)} data-testid={`theme-${p}`} />
                    {themeLabel(p, theme.resolved, theme.preference)}
                  </label>
                ))}
              </span>
            </div>
            <p className="muted rc-note">Stored with your user data; switching never touches a running simulation.</p>
            <div className="st-row">
              <span className="rc-label">motion</span>
              <Toggle label="reduced motion" checked={appearance.reducedMotion} onChange={(v) => set({ reducedMotion: v })} testId="setting-reduced-motion" help="no transitions; the OS setting is always followed" />
            </div>
            <div className="st-row">
              <span className="rc-label">dock</span>
              <Toggle label="dot grid" checked={appearance.dockGrid} onChange={(v) => set({ dockGrid: v })} testId="setting-dock-grid" help="the dots behind the panels" />
            </div>
          </section>

          <section className="fs" data-section="providers">
            <h4 className="sec">
              <b>2 · PROVIDERS AND KEYS</b>
              <span className="rule" />
            </h4>
            <p className="prose">
              No provider is configured: the agents here plan with algorithms, not with a language model. When providers arrive, each key is shown only as “●●●● set” or “○ not set”, with Replace and Remove; the value is never rendered.
            </p>
          </section>

          <section className="fs" data-section="storage">
            <h4 className="sec">
              <b>3 · STORAGE</b>
              <span className="rule" />
            </h4>
            <div className="st-row">
              <label className="rc-label" htmlFor="quota-threshold">
                Minimum quota for persistent storage
              </label>
              <span className="rc-inline">
                <span className="rc-input">
                  <input
                    id="quota-threshold"
                    type="number"
                    min={0}
                    step={16}
                    className="mono"
                    value={thresholdMb}
                    onChange={(e) => setThresholdMb(Math.max(0, Number(e.target.value) || 0))}
                  />
                  <span className="unit">MB</span>
                </span>
                <button type="button" className="btn" onClick={() => writeQuotaThreshold(thresholdMb * 1024 * 1024)}>
                  Save
                </button>
              </span>
            </div>
            <p className="muted rc-note">
              Below this quota (current default {formatBytes(256 * 1024 * 1024)}) the lab keeps data in memory only and asks you to export before closing. Applies on next reload.
            </p>
            <div className="st-row">
              <span className="rc-label">persistence</span>
              <span className="rc-inline">
                <button
                  type="button"
                  className="btn"
                  disabled={status.state !== "ready"}
                  onClick={async () => setPersistMsg((await storage.admin.requestPersistence()) ? "✓ persistent storage granted" : "▲ the browser declined")}
                >
                  Request persistent storage
                </button>
                {persistMsg && <span role="status">{persistMsg}</span>}
              </span>
            </div>
          </section>

          <section className="fs" data-section="layouts">
            <h4 className="sec">
              <b>4 · LAYOUTS</b>
              <span className="rule" />
            </h4>
            <div className="st-row">
              <span className="rc-label">workspaces</span>
              <button type="button" className="btn" onClick={resetLayouts}>
                Reset workspace layouts
              </button>
            </div>
            <p className="muted rc-note">Every workspace goes back to its preset. Layouts saved under a name stay.</p>
          </section>

          <section className="fs" data-section="keyboard">
            <h4 className="sec">
              <b>5 · KEYBOARD</b>
              <span className="rule" />
            </h4>
            <dl className="kv st-keys">
              {KEYS.map(([k, what]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
