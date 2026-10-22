import { GLYPH, useUiContext } from "@agentsim/ui";
import { useState, type ReactNode } from "react";
import type { WorkspaceId } from "../workspaces/presets.ts";

export interface TopBarProps {
  readonly workspaces: readonly { readonly id: WorkspaceId; readonly title: string }[];
  readonly workspace: WorkspaceId;
  readonly onWorkspace: (id: WorkspaceId) => void;
  /** Named layouts of the open workspace, and the one in use (none: the autosaved working layout). */
  readonly layouts: readonly string[];
  readonly layoutActive: string | undefined;
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
  readonly onPalette: () => void;
  /** The run popover (anchored to the run selector), when open. */
  readonly children?: ReactNode;
}

/**
 * The top bar (UI-SPEC §2, ADR-0042 §5): a tmux-like row of 28 px. The brand, the numbered workspaces (keys 1–5), the layout with its reset, the run selector,
 * the ◷ REPLAY segment while a recording is shown, and the palette. Plain token-styled elements: the shell is in the initial chunk.
 */
export function TopBar(props: TopBarProps) {
  return (
    <header className="top" aria-label="Workspaces and run" data-testid="topbar">
      <div className="seg brand">▣ AgentSimJS-NG</div>
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
      <LayoutSegment {...props} />
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
      {props.replaying && <ReplaySegment />}
      <div className="seg r">
        <button type="button" className="tb tip-right" onClick={props.onPalette} aria-label="Command palette" data-tip="Command palette · ctrl+k">
          ctrl+k
        </button>
      </div>
    </header>
  );
}

/** The persistent state of replay (UI-SPEC §2): not the accent, a segment of its own with the moment shown; it re-renders with the cursor and nothing else. */
function ReplaySegment() {
  const at = useUiContext((s) => s.simTime);
  return (
    <div className="seg r rpseg" role="status" data-testid="replay-segment">
      {GLYPH.replay} REPLAY · viewing t {at.toFixed(1)} s<span className="k k-opt"> · live run keeps running {GLYPH.running}</span>
    </div>
  );
}

/** The layout of the open workspace: the named ones to load, save (the name is asked in place), delete, and the reset to the preset. */
function LayoutSegment(props: TopBarProps) {
  const [naming, setNaming] = useState(false);
  return (
    <div className="seg r" data-testid="layout-segment">
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
        <button type="button" className="tb" onClick={() => setNaming(true)} data-tip="Save the dock as a named layout" data-testid="layout-save">
          save
        </button>
      )}
      {props.layoutActive !== undefined && (
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
