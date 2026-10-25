import "../panels.css";
import { KIND_STYLE, useUiContext } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppActions, usePolled, useServices, useSource } from "../../services.tsx";
import { summary } from "./log-rows.ts";
import { buildTraceTree, type TraceTree, type TreeNode } from "./trace-tree.ts";
import { useJump } from "./use-jump.ts";

/**
 * The trace tree of the Debug workspace (UI-SPEC section 4): around the record picked in the log, its parents, what it was caused by, its children and what it caused, a few
 * levels each with "more…". It reads the run through the storage ports, so it works while the run is being recorded (what is flushed) and on a recording. Clicking a node
 * picks that record: the log, the Timeline and the Scene follow it (the shared cursor and the shared record).
 */
export function TraceTreePanel() {
  const source = useSource();
  const { storage } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const jump = useJump(snap);
  const { openPanel } = useAppActions();
  const picked = useUiContext((s) => s.selectedRecord);
  const head = snap.persistedHeadTick ?? 0;
  const [tree, setTree] = useState<TraceTree | undefined | null>(null);
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const generation = useRef(0);
  // A small window (docked under the Log) lists one part at a time behind a row of toggles; a big one (maximized) lists them all.
  const box = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setCompact(el.clientHeight < 420);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const runId = snap.runId;
  const seq = picked !== undefined && picked.runId === runId ? picked.seq : undefined;

  // Another record starts the limits again; the same record in a run that grew is read again (a record's effects may have been stored since).
  useEffect(() => setLimits(new Map()), [runId, seq]);
  useEffect(() => {
    if (runId === undefined || seq === undefined) {
      setTree(null);
      return;
    }
    const mine = ++generation.current;
    void buildTraceTree(storage.ports, runId, seq, { limits }).then((t) => {
      if (mine === generation.current) setTree(t);
    });
  }, [storage, runId, seq, limits, head]);

  const more = (key: string, shown: number) => setLimits((cur) => new Map([...cur, [key, Math.max(shown * 3, shown + 12)]]));
  const open = (r: TraceRecord) => {
    if (runId === undefined) return;
    useUiContext.getState().selectRecord({ runId, seq: r.seq });
    jump(r.simTime, r.agentId);
  };

  return (
    <div ref={box} className="panel trace-tree" data-testid="trace-tree" data-compact={compact}>
      {seq === undefined ? (
        <p className="muted tt-empty" data-testid="trace-tree-empty">
          No record selected · pick one in the Log (↑ ↓ then Enter) to see what it came from and what came of it; T opens its graph.
        </p>
      ) : tree === null ? (
        <p className="muted tt-empty">Reading…</p>
      ) : tree === undefined ? (
        <p className="muted tt-empty" data-testid="trace-tree-missing">
          Record #{seq} is not in this run (yet).
        </p>
      ) : (
        <TreeView tree={tree} compact={compact} open={open} more={more} openGraph={() => openPanel("traceGraph")} />
      )}
    </div>
  );
}

function Line(props: { node: TreeNode; depth: number; selected?: boolean; open: (r: TraceRecord) => void }) {
  const { node, depth } = props;
  const r = node.record;
  const style = KIND_STYLE[r.kind as keyof typeof KIND_STYLE];
  return (
    <button
      type="button"
      className={`tt-node mono${props.selected ? " sel" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => props.open(r)}
      data-testid={props.selected ? "trace-tree-selected" : `trace-node-${r.seq}`}
      data-seq={r.seq}
      aria-current={props.selected ? "true" : undefined}
      title={`${r.id}${node.copyOf === undefined ? "" : ` · a copy of ${node.copyOf}`}`}
    >
      <span className="tag" style={{ color: `var(--kind-${style?.family ?? "slate"})` }}>
        [{style?.tag ?? r.kind.slice(0, 3).toUpperCase()}]
      </span>{" "}
      <span className="muted">{r.simTime.toFixed(2)} s</span> {r.agentId ?? "run"} <span className="muted">{r.source}</span> {summary(r)} <span className="muted">#{r.seq}</span>
      {node.copyOf !== undefined && (
        <span className="tt-copy" data-testid={`trace-copy-${r.seq}`}>
          {" "}
          ◇ copy of {node.copyOf}
        </span>
      )}
    </button>
  );
}

function Nodes(props: { nodes: readonly TreeNode[]; depth: number; keyOf: (n: TreeNode) => string; open: (r: TraceRecord) => void; more: (key: string, shown: number) => void; moreOf: (n: TreeNode) => number; keyMore: (n: TreeNode) => string }) {
  return (
    <>
      {props.nodes.map((n) => (
        <div key={n.record.seq}>
          <Line node={n} depth={props.depth} open={props.open} />
          {n.below.length > 0 && <Nodes {...props} nodes={n.below} depth={props.depth + 1} />}
          {n.more > 0 && (
            <button type="button" className="tt-more mono" style={{ paddingLeft: 8 + (props.depth + 1) * 14 }} onClick={() => props.more(props.keyMore(n), n.below.length)} data-testid={`trace-more-${props.keyMore(n)}`}>
              more… ({n.more})
            </button>
          )}
        </div>
      ))}
    </>
  );
}

type Part = "parents" | "causes" | "children" | "effects";

/** The part a compact view opens with: the first that is not empty after the record (children, then effects), else before it (causes, then parents). */
export function firstPart(c: Record<Part, number>): Part {
  return (["children", "effects", "causes", "parents"] as const).find((k) => c[k] > 0) ?? "children";
}

function TreeView(props: { tree: TraceTree; compact: boolean; open: (r: TraceRecord) => void; more: (key: string, shown: number) => void; openGraph: () => void }) {
  const { tree, open, more, compact } = props;
  const counts: Record<Part, number> = { parents: tree.ancestors.length, causes: tree.causes.length, children: tree.children.length, effects: tree.effects.length };
  const [chosen, setChosen] = useState<{ seq: number; part: Part } | undefined>(undefined);
  const active: Part = chosen !== undefined && chosen.seq === tree.selected.record.seq ? chosen.part : firstPart(counts);
  const root = useRef<HTMLDivElement>(null);
  const pick = (part: Part) => {
    setChosen({ seq: tree.selected.record.seq, part });
    // Where every part is listed, a toggle takes its part into view; in a small window it opens the part.
    if (!compact) root.current?.querySelector(`[data-testid="tt-${part === "parents" ? "parents" : part === "causes" ? "causes" : part}"]`)?.scrollIntoView?.({ block: "nearest" });
  };
  const head: { part: Part; glyph: string; label: string }[] = [
    { part: "parents", glyph: "↑", label: "parents" },
    { part: "causes", glyph: "←", label: "causes" },
    { part: "children", glyph: "↓", label: "children" },
    { part: "effects", glyph: "→", label: "effects" },
  ];
  const section = (part: Part, title: string, glyph: string, testId: string, body: React.ReactNode, count: number) =>
    compact && active !== part ? null : (
      <section className="tt-section" data-testid={testId}>
        <h4>
          {glyph} {title} <span className="muted">· {count}</span>
        </h4>
        {count === 0 ? <p className="muted tt-none">none</p> : body}
      </section>
    );
  const base = { open, more, moreOf: (n: TreeNode) => n.more, keyOf: (n: TreeNode) => String(n.record.seq) };
  return (
    <div ref={root} className="tt-body">
      <div className="tt-head mono" role="group" aria-label="Parts of the tree" data-testid="tt-head">
        {head.map((h) => (
          <button key={h.part} type="button" className={`kt${compact && active === h.part ? " on" : ""}`} aria-pressed={compact ? active === h.part : undefined} onClick={() => pick(h.part)} data-testid={`tt-tab-${h.part}`}>
            {h.glyph} {h.label} <span className="muted">{counts[h.part]}</span>
          </button>
        ))}
        <span className="sp" />
        <button type="button" className="kt tip-right" onClick={props.openGraph} data-tip="A window with this record and what is around it as a graph · press T on a selected record" data-testid="trace-open-graph">
          ⧉ open graph · T
        </button>
      </div>
      {section(
        "parents",
        "parents",
        "↑",
        "tt-parents",
        <>
          {[...tree.ancestors].reverse().map((a, i) => (
            <Line key={a.record.seq} node={a} depth={i} open={open} />
          ))}
          {tree.ancestorsMore && (
            <button type="button" className="tt-more mono" onClick={() => more("up", tree.ancestors.length)} data-testid="trace-more-up">
              more parents…
            </button>
          )}
        </>,
        tree.ancestors.length,
      )}
      {section(
        "causes",
        "caused by",
        "←",
        "tt-causes",
        <>
          <Nodes {...base} nodes={tree.causes} depth={0} keyMore={(n) => `causes:${n.record.seq}`} />
          {tree.causesMore > 0 && (
            <button type="button" className="tt-more mono" onClick={() => more(`causes:${tree.selected.record.seq}`, tree.causes.length)} data-testid={`trace-more-causes:${tree.selected.record.seq}`}>
              more… ({tree.causesMore})
            </button>
          )}
        </>,
        tree.causes.length,
      )}
      <section className="tt-section" data-testid="tt-record">
        <h4>● this record</h4>
        <Line node={tree.selected} depth={0} selected open={open} />
      </section>
      {section(
        "children",
        "children",
        "↓",
        "tt-children",
        <>
          <Nodes {...base} nodes={tree.children} depth={0} keyMore={(n) => `children:${n.record.seq}`} />
          {tree.childrenMore > 0 && (
            <button type="button" className="tt-more mono" onClick={() => more(`children:${tree.selected.record.seq}`, tree.children.length)} data-testid={`trace-more-children:${tree.selected.record.seq}`}>
              more… ({tree.childrenMore})
            </button>
          )}
        </>,
        tree.children.length,
      )}
      {section(
        "effects",
        "effects",
        "→",
        "tt-effects",
        <>
          <Nodes {...base} nodes={tree.effects} depth={0} keyMore={(n) => `effects:${n.record.seq}`} />
          {tree.effectsMore > 0 && (
            <button type="button" className="tt-more mono" onClick={() => more(`effects:${tree.selected.record.seq}`, tree.effects.length)} data-testid={`trace-more-effects:${tree.selected.record.seq}`}>
              more… ({tree.effectsMore})
            </button>
          )}
        </>,
        tree.effects.length,
      )}
    </div>
  );
}
