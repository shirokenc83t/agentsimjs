import { GLYPH, useTheme, useUiContext, type ThemePreference } from "@agentsim/ui";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ReplayDerived } from "../sim/run-source.ts";
import type { WorkspaceId } from "../workspaces/presets.ts";

export interface TopBarProps {
  readonly workspaces: readonly { readonly id: WorkspaceId; readonly title: string }[];
  readonly workspace: WorkspaceId;
  readonly onWorkspace: (id: WorkspaceId) => void;
  /** Named layouts of the open workspace, and the one in use (none: the autosaved working layout). */
  readonly layouts: readonly string[];
  readonly layoutActive: string | undefined;
  /** The layout in use ships with the app: it cannot be saved over or deleted. */
  readonly layoutBuiltin?: boolean;
  readonly onSelectLayout: (name: string | undefined) => void;
  readonly onSaveLayout: (name: string) => void;
  readonly onDeleteLayout: () => void;
  readonly onResetLayout: () => void;
  /** `run-000001 · f1-demo v1`, or `run: —` with no run. */
  readonly runLabel: string;
  readonly runOpen: boolean;
  readonly onRunClick: (anchor: HTMLElement) => void;
  /** The panels show a recording (the live run goes on behind it). */
  readonly replaying: boolean;
  /** When the recording shown is a re-simulated window of another run: where it comes from and its verdict. */
  readonly derived?: ReplayDerived | undefined;
  readonly onPalette: () => void;
  /** The theme chosen from the theme menu (dark, light, system). */
  readonly onTheme: (preference: ThemePreference) => void;
  /** The run popover (anchored to the run selector), when open. */
  readonly children?: ReactNode;
}

/**
 * The top bar (UI-SPEC §2, ADR-0042 §5): a tmux-like row of 28 px. The brand, the numbered workspaces (keys 1–7), the layout with its reset, the run selector,
 * the ◷ REPLAY segment while a recording is shown, and the palette. Plain token-styled elements: the shell is in the initial chunk.
 */
export function TopBar(props: TopBarProps) {
  // When the bar does not fit its row, the layout controls fold into one `layout ▾` button first (U-010 §8): the theme button and ctrl+k always stay. It is measured, not a
  // width: what is in the bar (a derived replay's long segment, the name of the run) decides. It unfolds again when the room is back.
  const bar = useRef<HTMLElement>(null);
  const [folded, setFolded] = useState(false);
  // When even the folded bar is too wide (a derived replay's long segment at a narrow window), the theme button gives up its word and keeps its glyph.
  const [compact, setCompact] = useState(false);
  const needed = useRef(0);
  useLayoutEffect(() => (setFolded(false), setCompact(false)), [props.replaying, props.derived, props.runLabel, props.workspaces.length, props.layoutActive]);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    // The room the content wants: every segment at its own width, none shrunk or clipped (tooltips hang outside the flow and are not counted).
    const natural = (): number => {
      el.classList.add("nat");
      const own = getComputedStyle(el);
      const gaps = (Number.parseFloat(own.columnGap) || 0) * Math.max(0, el.children.length - 1);
      const w = Array.from(el.children).reduce((n, c) => n + (c as HTMLElement).offsetWidth, 0) + gaps + (Number.parseFloat(own.paddingLeft) || 0) + (Number.parseFloat(own.paddingRight) || 0);
      el.classList.remove("nat");
      return w;
    };
    const fit = () => {
      if (!folded) {
        const want = natural();
        if (want > el.clientWidth) {
          needed.current = want;
          setFolded(true);
        }
      } else {
        if (el.clientWidth >= needed.current) setFolded(false);
        else if (natural() > el.clientWidth) setCompact(true);
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [folded, props.replaying, props.derived, props.runLabel, props.layoutActive]);
  return (
    <header className={`top${compact ? " compact" : ""}`} aria-label="Workspaces and run" data-testid="topbar" ref={bar}>
      <div className="seg brand">
        <span className="mark" aria-hidden="true">
          {""}
        </span>{" "}
        AgentSimJS-NG
      </div>
      <nav className="seg ws-nav" aria-label="Workspaces">
        {props.workspaces.map((w, i) => (
          <button
            key={w.id}
            type="button"
            className={`ws${w.id === props.workspace ? " on" : ""}`}
            aria-current={w.id === props.workspace ? "page" : undefined}
            aria-label={`${w.title} workspace, key ${i + 1}`}
            onClick={() => props.onWorkspace(w.id)}
            data-testid={`tab-${w.id}`}
          >
            <b>{i + 1}</b>
            {w.title.toLowerCase()}
          </button>
        ))}
      </nav>
      <div className="sp" />
      {folded ? <LayoutMenu {...props} /> : <LayoutSegment {...props} />}
      <div className="seg r">
        <span className="k k-opt">run</span>
        <button
          type="button"
          className="tb runsel mono"
          onClick={(e) => props.onRunClick(e.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={props.runOpen}
          data-testid="run-label"
        >
          {props.runLabel} <span className="k">▾</span>
        </button>
        {props.children}
      </div>
      {props.replaying && <ReplaySegment derived={props.derived} />}
      <div className="seg r">
        <ThemeMenu onTheme={props.onTheme} />
      </div>
      <div className="seg r">
        <button type="button" className="tb tip-right" onClick={props.onPalette} aria-label="Command palette" data-tip="Command palette · ctrl+k">
          ctrl+k
        </button>
      </div>
    </header>
  );
}

/**
 * The persistent state of replay (UI-SPEC §2): not the accent, a segment of its own with the moment shown; it re-renders with the cursor and nothing else. A derived run is
 * shown compactly (`◷ t 0.0 · ◇ 9.0–18.0 of run-000001 · ✓`, the whole text in the tooltip): the palette and the attention tile have priority and never leave the screen.
 */
function ReplaySegment(props: { derived: ReplayDerived | undefined }) {
  const at = useUiContext((s) => s.simTime);
  const d = props.derived;
  if (d === undefined) {
    return (
      <div className="seg r rpseg" role="status" data-testid="replay-segment">
        {GLYPH.replay} REPLAY · viewing t {at.toFixed(1)} s
        <span className="k k-opt"> · live run keeps running {GLYPH.running}</span>
      </div>
    );
  }
  const verdict = d.status === "matches" ? "every recorded checkpoint in the window was reproduced" : `the first checkpoint that was not reproduced is at tick ${d.divergenceTick ?? "?"}`;
  return (
    <div className="seg r rpseg" role="status" data-testid="replay-segment" title={`REPLAY · viewing t ${at.toFixed(1)} s · a re-simulated window (${d.t0S.toFixed(1)}–${d.t1S.toFixed(1)} s) of ${d.parentRunId}: ${verdict} · the live run keeps running`}>
      {GLYPH.replay} t {at.toFixed(1)}
      <span data-testid="replay-derived">
        {" "}· ◇ {d.t0S.toFixed(1)}–{d.t1S.toFixed(1)} of {d.parentRunId} · {d.status === "matches" ? <span className="ok">✓</span> : <span className="danger">{GLYPH.fail} @{d.divergenceTick ?? "?"}</span>}
      </span>
    </div>
  );
}

/** The layout of the open workspace: the named ones to load, save (the name is asked in place), delete, and the reset to the preset. */
function LayoutSegment(props: TopBarProps) {
  const [naming, setNaming] = useState(false);
  return (
    <div className="seg r layout-seg" data-testid="layout-segment">
      <span className="k k-opt">layout</span>
      <select className="tb" aria-label="Layout" value={props.layoutActive ?? ""} onChange={(e) => props.onSelectLayout(e.target.value === "" ? undefined : e.target.value)} data-testid="layout-select">
        <option value="">autosaved</option>
        {props.layouts.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {naming ? (
        <input
          className="tb mono"
          autoFocus
          aria-label="Name of the layout"
          placeholder="name, Enter to save"
          maxLength={40}
          data-testid="layout-name-input"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              props.onSaveLayout(e.currentTarget.value);
              setNaming(false);
            } else if (e.key === "Escape") setNaming(false);
          }}
          onBlur={() => setNaming(false)}
        />
      ) : (
        <button type="button" className="tb" disabled={props.layoutBuiltin} onClick={() => setNaming(true)} data-tip={props.layoutBuiltin ? "This layout ships with the app" : "Save the dock as a named layout"} data-testid="layout-save">
          save
        </button>
      )}
      {props.layoutActive !== undefined && !props.layoutBuiltin && (
        <button type="button" className="tb" onClick={props.onDeleteLayout} data-tip="Delete this named layout" data-testid="layout-delete">
          delete
        </button>
      )}
      <button type="button" className="tb" onClick={props.onResetLayout} data-tip="Reset this workspace's layout to the preset" data-testid="layout-reset">
        reset
      </button>
    </div>
  );
}

/**
 * The theme control (ADR-0042, U-010): a 24 px `◐` between the run selector and the palette, a menu of dark, light and system (with what system is now), the current one
 * checked. `Ctrl+Shift+L` toggles dark and light from anywhere (the app owns that key). The tooltip says the theme in use.
 */
function ThemeMenu(props: { onTheme: (preference: ThemePreference) => void }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const items: readonly { readonly value: ThemePreference; readonly label: string }[] = [
    { value: "dark", label: "● dark" },
    { value: "light", label: "○ light" },
    { value: "system", label: `◐ system · now ${theme.resolved}` },
  ];
  return (
    <div className="theme-menu" ref={box}>
      <button
        type="button"
        className="tb theme-btn tip-right"
        aria-label={`Theme: ${theme.preference === "system" ? `system (${theme.resolved})` : theme.preference}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={`Theme: ${theme.preference === "system" ? `system, now ${theme.resolved}` : theme.preference} · ctrl+shift+L toggles dark and light`}
        onClick={() => setOpen((o) => !o)}
        data-testid="theme-button"
      >
        ◐<span className="lbl"> {theme.preference} </span><span className="k">▾</span>
      </button>
      {open && (
        <div className="theme-pop" role="menu" aria-label="Theme" data-testid="theme-menu">
          {items.map((it) => (
            <button
              key={it.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme.preference === it.value}
              className={`tb${theme.preference === it.value ? " on" : ""}`}
              onClick={() => {
                props.onTheme(it.value);
                setOpen(false);
              }}
              data-testid={`theme-${it.value}`}
            >
              <span className="chk">{theme.preference === it.value ? "✓" : ""}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The layout controls folded into one button: the same select, save, delete and reset, in a small menu under it. */
function LayoutMenu(props: TopBarProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="seg r layout-fold" ref={box}>
      <button type="button" className="tb tip-right" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="layout-fold" data-tip={`Layout: ${props.layoutActive ?? "autosaved"}`}>
        layout <span className="k">▾</span>
      </button>
      {open && (
        <div className="layout-pop" role="menu" aria-label="Layout" data-testid="layout-menu">
          <LayoutSegment {...props} />
        </div>
      )}
    </div>
  );
}
