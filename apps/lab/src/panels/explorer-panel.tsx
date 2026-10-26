import "./panels.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GLYPH, identityOf, KIND_STYLE, STATE_GLYPH, useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { usePolled, useSource } from "../services.tsx";
import { actionLabel, actionState } from "./agent-views.ts";
import { AttentionCounts } from "../shell/attention-counts.tsx";
import { useAttention } from "./attention-store.ts";
import { useAgentViews } from "./use-agent-views.ts";

/**
 * Explorer (UI-SPEC §4): the run's entities, agents only in F1. Virtualized (ADR-0016: long lists are, and
 * the same component serves swarms later). Each row is one line of 24 px: the identity swatch, the ID, the key, the kind tag and the action state (glyph + text).
 * Above them, the attention group: the agents that need a look, alarms first, with the condition and its age. Selecting a row selects the agent everywhere through
 * the UI context.
 */
/** Height of a row (px): one line. */
const ROW_PX = 24;
export function ExplorerPanel() {
  const source = useSource();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const views = useAgentViews(source);
  const attn = useAttention(source);
  const [attnFilter, setAttnFilter] = useState<"all" | "alarm" | "warning">("all");
  const [attnOpen, setAttnOpen] = useState(true);
  const selection = useUiContext((s) => s.selection);
  const agents = snap.run?.agents ?? [];
  const ideal = new Set(snap.run?.idealAgents ?? []);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: agents.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX, overscan: 8 });
  const selectedIndex = selection?.kind === "agent" ? agents.findIndex((a) => a.id === selection.id) : -1;

  // Keep the selected row in view when the selection comes from another panel.
  useEffect(() => {
    if (selectedIndex >= 0) virtual.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtual]);

  const select = (i: number) => {
    const a = agents[i];
    if (a) useUiContext.getState().select({ kind: "agent", id: a.id });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.min(agents.length - 1, Math.max(0, selectedIndex + (e.key === "ArrowDown" ? 1 : -1)));
    select(next);
  };

  if (!snap.run) return <div className="panel muted">No run loaded. Load one from the run menu in the toolbar.</div>;
  const needing = agents
    .map((a) => ({ a, c: attn.byAgent.get(a.id)?.conditions[0] }))
    .filter((x): x is { a: (typeof agents)[number]; c: NonNullable<typeof x.c> } => x.c !== undefined && (attnFilter === "all" || x.c.level === attnFilter))
    .sort((x, y) => (x.c.level === y.c.level ? y.c.sinceS - x.c.sinceS : x.c.level === "alarm" ? -1 : 1));
  const total = attn.counts.alarm + attn.counts.warning;
  return (
    <div className="panel explorer" data-testid="explorer">
      {total > 0 && (
        <div className="attention-group" data-testid="explorer-attention">
          <div className="grp attn">
            <button type="button" className="grp-toggle" aria-expanded={attnOpen} onClick={() => setAttnOpen((o) => !o)}>
              {attnOpen ? "▾" : "▸"} attention{" "}
              <AttentionCounts alarm={attn.counts.alarm} warning={attn.counts.warning} />
            </button>
            <span className="sp" />
            {(["alarm", "warning", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`chip${attnFilter === f ? " on" : ""}`}
                aria-pressed={attnFilter === f}
                aria-label={f === "alarm" ? "Alarms only" : f === "warning" ? "Warnings only" : "All"}
                data-tip={f === "alarm" ? "Alarms only" : f === "warning" ? "Warnings only" : "All"}
                onClick={() => setAttnFilter(f)}
                data-testid={`attention-filter-${f}`}
              >
                {f === "alarm" ? `${GLYPH.fail} only` : f === "warning" ? `${GLYPH.warn} only` : "all"}
              </button>
            ))}
          </div>
          {attnOpen &&
            needing.map(({ a, c }) => {
              const idn = identityOf(agents.indexOf(a));
              return (
                <div
                  key={a.id}
                  role="button"
                  tabIndex={0}
                  className={`attention-row selectable ${c.level}${selection?.kind === "agent" && selection.id === a.id ? " selected" : ""}`}
                  data-testid={`explorer-attention-${a.id}`}
                  onClick={() => useUiContext.getState().select({ kind: "agent", id: a.id })}
                  onKeyDown={(e) => e.key === "Enter" && useUiContext.getState().select({ kind: "agent", id: a.id })}
                >
                  <span className={`agent-swatch ${idn.style}`} style={{ ["--swatch" as string]: `var(--agent-${idn.colorIndex})` }} />
                  <span className="mono">{a.id}</span>
                  <span className={`mono ${c.level === "alarm" ? "st-alm" : "st-warn"}`}>
                    {c.glyph} {c.label}
                  </span>
                  <span className="muted mono">{Math.max(0, snap.simTimeS - c.sinceS).toFixed(0)} s</span>
                </div>
              );
            })}
        </div>
      )}
      <div
        ref={scroller}
        className="explorer-list"
        role="listbox"
        aria-label="Agents"
        tabIndex={0}
        onKeyDown={onKey}
        aria-activedescendant={selectedIndex >= 0 ? `explorer-${agents[selectedIndex]?.id ?? ""}` : undefined}
      >
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((row) => {
            const a = agents[row.index];
            if (!a) return null;
            const action = views.get(a.id)?.action;
            const state = actionState(action);
            return (
              <div
                key={a.id}
                id={`explorer-${a.id}`}
                role="option"
                aria-selected={row.index === selectedIndex}
                data-testid={`explorer-row-${a.id}`}
                className={`explorer-row selectable${attn.byAgent.get(a.id)?.conditions[0] ? " in-attention" : ""}`}
                title={attn.byAgent.get(a.id)?.conditions[0] ? "Listed above, in attention" : undefined}
                onClick={() => select(row.index)}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: row.size, transform: `translateY(${row.start}px)` }}
              >
                <span className={`agent-swatch ${identityOf(row.index).style}`} style={{ ["--swatch" as string]: `var(--agent-${identityOf(row.index).colorIndex})` }} />
                <span className="mono">{a.id}</span>
                <span className="muted">{a.key ?? ""}</span>
                <span className="kind-tag mono">{a.kind.toUpperCase()}</span>
                <span className={`mono st-${state}`} data-testid={`explorer-state-${a.id}`}>
                  {STATE_GLYPH[state]} {actionLabel(action, views.get(a.id)?.reflex)}
                  {ideal.has(a.id) && (
                    <span className="kind-tag" data-testid={`explorer-ideal-${a.id}`} title="ideal: plans on the ground truth (baseline), not on its own map">
                      {" "}
                      ◆ ideal
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="muted legend nowrap" title={`${agents.length} agents · ${KIND_STYLE.action.tag} state comes from the action trace`}>
        {agents.length} agents · state from trace
      </p>
    </div>
  );
}
