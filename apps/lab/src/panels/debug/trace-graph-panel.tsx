import "../panels.css";
import { KIND_STYLE, useUiContext } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { kindOpShort, LANE_PAGE, layoutTraceGraph, NODE_W, nodeLines, outcomeGlyph, PAGE, RAIL_W, type GraphLayout, type GraphNode, type Side } from "./trace-graph-layout.ts";
import { buildTraceTree, type TraceTree } from "./trace-tree.ts";
import { useJump } from "./use-jump.ts";

/**
 * The trace graph window: the record picked in the log and what is around it, left to right: parents (solid edges) and causes (dashed) on the left, the record, its children as one
 * vertical time line (a lane: a dot a step, the time and the gaps on the left, runs of the same kind · op folded, a long middle collapsed, scrolling when it is long) and its effects
 * (dashed) on the right, never moved by a force. A click selects (the shared cursor and record: the Log, the Timeline and the Inspector follow), a double click or Enter puts the graph
 * around that record with a breadcrumb back (Backspace goes back), the arrows move between nodes, and a side panel has the record's fields and its JSON.
 */
export function TraceGraphPanel() {
  const source = useSource();
  const { storage } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const jump = useJump(snap);
  const picked = useUiContext((s) => s.selectedRecord);
  const runId = snap.runId;
  const head = snap.persistedHeadTick ?? 0;
  const sharedSeq = picked !== undefined && picked.runId === runId ? picked.seq : undefined;

  const [center, setCenter] = useState<number | undefined>(sharedSeq);
  const [trail, setTrail] = useState<readonly number[]>([]);
  const [depth, setDepth] = useState<1 | 2 | 3>(1);
  const [sides, setSides] = useState<Record<Side, boolean>>({ parents: true, causes: true, children: true, effects: true });
  const [foldRuns, setFoldRuns] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, number>>(new Map());
  const [tree, setTree] = useState<TraceTree | undefined | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const generation = useRef(0);
  // How long the tree has been read for, in seconds, while it is.
  const [reading, setReading] = useState(0);
  useEffect(() => {
    if (tree !== null) return;
    const t0 = Date.now();
    setReading(0);
    const timer = setInterval(() => setReading(Math.round((Date.now() - t0) / 100) / 10), 200);
    return () => clearInterval(timer);
  }, [tree]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(160, el.clientHeight) });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // The record picked elsewhere is the one the graph is about, unless it is already a node of it (then it is only marked).
  const layoutKeys = useRef<ReadonlySet<number>>(new Set());
  useEffect(() => {
    if (sharedSeq === undefined) return;
    if (center === undefined || !layoutKeys.current.has(sharedSeq)) {
      setCenter(sharedSeq);
      setTrail([]);
      setExpanded(new Map());
    }
  }, [sharedSeq, runId]);

  useEffect(() => {
    if (runId === undefined || center === undefined) {
      setTree(null);
      return;
    }
    const mine = ++generation.current;
    void buildTraceTree(storage.ports, runId, center, { depthUp: depth, depthCauses: depth, depthDown: depth, perNode: 400 }).then((t) => {
      if (mine === generation.current) setTree(t);
    });
  }, [storage, runId, center, depth, head]);

  const layout = useMemo<GraphLayout | undefined>(() => (tree ? layoutTraceGraph(tree, { depth, sides, foldRuns, expanded }) : undefined), [tree, depth, sides, foldRuns, expanded]);
  useEffect(() => {
    layoutKeys.current = new Set((layout?.nodes ?? []).flatMap((n) => (n.record ? [n.record.seq] : [])));
  }, [layout]);

  const PAD = 24;
  const fit = layout ? Math.min(1, (size.w - 2 * PAD) / layout.width, (size.h - 2 * PAD) / layout.height) : 1;
  const scale = zoom === "fit" ? fit : zoom;

  const select = (r: TraceRecord) => {
    if (runId === undefined) return;
    useUiContext.getState().selectRecord({ runId, seq: r.seq });
    jump(r.simTime, r.agentId);
  };
  const recentre = (seq: number) => {
    if (seq === center) return;
    setTrail((t) => (center === undefined ? t : [...t, center]));
    setCenter(seq);
    setExpanded(new Map());
  };
  const back = () => {
    const prev = trail[trail.length - 1];
    if (prev === undefined) return;
    setTrail((t) => t.slice(0, -1));
    setCenter(prev);
    setExpanded(new Map());
  };
  // A group of effects opens a page, the lane's middle a page of rows, a run all at once.
  const expand = (g: NonNullable<GraphNode["group"]>) => setExpanded((m) => new Map([...m, [g.key, g.kind === "run" ? 1 : (m.get(g.key) ?? 0) + (g.kind === "gap" ? LANE_PAGE : PAGE)]]));

  const onKey = (e: KeyboardEvent<HTMLDivElement>, n: GraphNode) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      back();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (n.record) recentre(n.record.seq);
      else if (n.group) expand(n.group);
    } else if (e.key === " ") {
      e.preventDefault();
      if (n.record) select(n.record);
      else if (n.group) expand(n.group);
    } else if (e.key.startsWith("Arrow") && layout) {
      e.preventDefault();
      const next = neighbour(layout.nodes, n, e.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown");
      if (next) {
        setFocusKey(next.key);
        box.current?.querySelector<HTMLElement>(`[data-node="${next.key}"]`)?.focus();
      }
    }
  };

  const selectedRecord = layout?.nodes.find((n) => n.record?.seq === sharedSeq)?.record ?? (tree ? tree.selected.record : undefined);
  const centerRecord = tree ? tree.selected.record : undefined;
  const centerNode = layout?.nodes.find((n) => n.center);

  if (center === undefined) {
    return (
      <div className="panel tg" data-testid="trace-graph">
        <p className="muted tt-empty" data-testid="trace-graph-empty">
          Pick a record in the log: the graph shows what it came from and what came of it.
        </p>
      </div>
    );
  }
  return (
    <div className="panel tg" data-testid="trace-graph">
      <div className="tg-bar mono" role="toolbar" aria-label="Graph controls">
        <span className="tg-group" role="group" aria-label="Depth">
          depth
          {([1, 2, 3] as const).map((d) => (
            <button key={d} type="button" className={`kt${depth === d ? " on" : ""}`} aria-pressed={depth === d} onClick={() => setDepth(d)} data-testid={`tg-depth-${d}`}>
              {d}
            </button>
          ))}
        </span>
        <span className="tg-group" role="group" aria-label="Sides">
          {(
            [
              ["parents", "↑ parents"],
              ["causes", "← causes"],
              ["children", "↓ the lane"],
              ["effects", "→ effects"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={`kt${sides[k] ? "" : " off"}`} aria-pressed={sides[k]} onClick={() => setSides((s) => ({ ...s, [k]: !s[k] }))} data-testid={`tg-side-${k}`}>
              {label}
            </button>
          ))}
        </span>
        <label className="tg-check">
          <input type="checkbox" checked={foldRuns} onChange={(e) => setFoldRuns(e.target.checked)} data-testid="tg-fold" /> fold runs of the same kind · op
        </label>
        <button type="button" className="kt" onClick={() => setZoom("fit")} data-testid="tg-fit" data-tip="Fit the graph to the window">
          fit
        </button>
        <button type="button" className="kt" onClick={() => setZoom(Math.min(2, Math.round((scale + 0.1) * 10) / 10))} aria-label="Zoom in" data-testid="tg-zoom-in">
          +
        </button>
        <button type="button" className="kt" onClick={() => setZoom(Math.max(0.3, Math.round((scale - 0.1) * 10) / 10))} aria-label="Zoom out" data-testid="tg-zoom-out">
          −
        </button>
        <span className="sp" />
        <nav className="tg-crumbs" aria-label="The path from the run to this record" data-testid="tg-crumbs">
          {trail.map((s, i) => (
            <span key={`${s}-${i}`} className="tg-visited">
              <button type="button" className="kt" onClick={() => (setCenter(s), setTrail(trail.slice(0, i)), setExpanded(new Map()))} data-testid={`tg-crumb-${s}`}>
                #{s}
              </button>
              {" › "}
            </span>
          ))}
          {[...(tree?.ancestors ?? [])].reverse().map((a) => (
            <span key={`up-${a.record.seq}`}>
              <button type="button" className="kt" onClick={() => recentre(a.record.seq)} data-testid={`tg-up-${a.record.seq}`} title={`${nodeLines(a.record).top} · its parent`}>
                #{a.record.seq} {kindOpShort(a.record)}
              </button>
              {" › "}
            </span>
          ))}
          <b data-testid="tg-center" title={tree ? nodeLines(tree.selected.record).top : undefined}>
            #{center}
          </b>
          {trail.length > 0 && (
            <button type="button" className="kt" onClick={back} aria-label="Back to the previous record (Backspace)" data-testid="tg-back">
              ⌫ back
            </button>
          )}
        </nav>
      </div>
      <div className="tg-body">
        <div className="tg-canvas" ref={box} data-testid="tg-canvas">
          {tree === null && (
            // The tree is read from storage by filters that scan the run (a record's children and effects are found by `parent:` and `cause:`, which no index serves yet): on a long run it takes
            // seconds, so the window says what it is doing and for how long, with the shape of what is coming.
            <div className="tg-reading" role="status" aria-busy="true" data-testid="tg-reading">
              <p className="muted tt-empty">Reading the records around #{center} from storage… {reading} s</p>
              <span className="tg-skeleton" aria-hidden="true" />
            </div>
          )}
          {tree === undefined && (
            <p className="muted tt-empty" data-testid="tg-missing">
              Record #{center} is not in this run (yet).
            </p>
          )}
          {layout && (
            <div className="tg-stage" style={{ width: layout.width * scale + 2 * PAD, height: layout.height * scale + 2 * PAD }}>
              <div className="tg-scaled" style={{ transform: `translate(${PAD}px, ${PAD}px) scale(${scale})`, width: layout.width, height: layout.height }} data-testid="tg-scaled" data-scale={scale.toFixed(2)}>
                <svg className="tg-edges" width={layout.width} height={layout.height} aria-hidden="true">
                  {layout.edges.map((e) => {
                    const a = layout.nodes.find((n) => n.key === e.from);
                    const b = layout.nodes.find((n) => n.key === e.to);
                    if (!a || !b) return null;
                    const x1 = a.x + NODE_W;
                    const y1 = a.y + a.h / 2;
                    const x2 = b.x;
                    const y2 = b.y + b.h / 2;
                    const mid = (x1 + x2) / 2;
                    return <path key={`${e.from}>${e.to}:${e.relation}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} className={`tg-edge ${e.relation}${e.failed ? " failed" : ""}`} data-testid={`tg-edge-${e.relation}`} />;
                  })}
                  {layout.lane &&
                    centerNode &&
                    (() => {
                      // A bracket from the record to the lane: out of its right side to a vertical bar along the lane.
                      const x1 = centerNode.x + NODE_W;
                      const y1 = centerNode.y + centerNode.h / 2;
                      const xb = layout.lane.x - GAP_BRACKET;
                      const y0 = layout.lane.y + 6;
                      const y2 = layout.lane.y + layout.lane.viewH - 6;
                      return <path d={`M${x1},${y1} H${xb} M${xb},${y0} V${y2} M${xb},${y0} H${layout.lane.x - 2} M${xb},${y2} H${layout.lane.x - 2}`} className="tg-edge parent" data-testid="tg-bracket" />;
                    })()}
                </svg>
                {layout.nodes
                  .filter((n) => !n.lane)
                  .map((n) => (
                    <GraphNodeView
                      key={n.key}
                      n={n}
                      ox={0}
                      oy={0}
                      selected={n.record?.seq === sharedSeq}
                      tabbable={focusKey === n.key || (focusKey === undefined && n.center)}
                      onSelect={select}
                      onRecentre={recentre}
                      onExpand={expand}
                      onKey={onKey}
                      onFocus={() => setFocusKey(n.key)}
                    />
                  ))}
                {layout.lane && (
                  <div className="tg-lane" style={{ left: layout.lane.x, top: layout.lane.y, width: layout.lane.width, height: layout.lane.viewH }} data-testid="tg-lane" data-total={layout.lane.total} role="group" aria-label={`What it did: ${layout.lane.total} records in time order`}>
                    <div className="tg-lane-content" style={{ height: layout.lane.contentH }}>
                      <span className="tg-rail" style={{ left: RAIL_W - 14, height: layout.lane.contentH }} aria-hidden="true" />
                      {layout.nodes
                        .filter((n) => n.lane)
                        .map((n) => {
                          const top = n.y - (layout.lane as { y: number }).y;
                          return (
                            <span key={`t:${n.key}`}>
                              {n.lane?.gap !== undefined && (
                                <span className="tg-gap mono muted" style={{ top: top - 14, width: RAIL_W - 24 }} data-testid="tg-lane-gap">
                                  {n.lane.gap}
                                </span>
                              )}
                              {n.lane && n.lane.time !== "" && (
                                <span className="tg-time mono muted" style={{ top: top + n.h / 2 - 8, width: RAIL_W - 24 }}>
                                  {n.lane.time}
                                </span>
                              )}
                              <span className={`tg-dot${n.failed ? " alm" : n.lane?.ok ? " ok" : ""}${n.group ? " hollow" : ""}`} style={{ left: RAIL_W - 14 - 4, top: top + n.h / 2 - 4 }} aria-hidden="true" />
                            </span>
                          );
                        })}
                      {layout.nodes
                        .filter((n) => n.lane)
                        .map((n) => (
                          <GraphNodeView
                            key={n.key}
                            n={n}
                            ox={layout.lane?.x ?? 0}
                            oy={layout.lane?.y ?? 0}
                            selected={n.record?.seq === sharedSeq}
                            tabbable={focusKey === n.key}
                            onSelect={select}
                            onRecentre={recentre}
                            onExpand={expand}
                            onKey={onKey}
                            onFocus={() => setFocusKey(n.key)}
                          />
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <aside className="tg-side" aria-label="The selected record" data-testid="tg-side">
          {selectedRecord ? <RecordFields r={selectedRecord} center={centerRecord?.seq === selectedRecord.seq} /> : <p className="muted tt-empty">Nothing selected.</p>}
        </aside>
      </div>
      <p className="muted tg-keys mono">↑ ↓ ← → move · ⏎ recentre · ⌫ back · space select · click a folded row to open it</p>
    </div>
  );
}

/** The room between the bracket of the lane and the lane. */
const GAP_BRACKET = 40;

function GraphNodeView(props: {
  n: GraphNode;
  /** The origin the node's position is read from: the stage's, or the lane's for a step of the lane. */
  ox: number;
  oy: number;
  selected: boolean;
  tabbable: boolean;
  onSelect: (r: TraceRecord) => void;
  onRecentre: (seq: number) => void;
  onExpand: (g: NonNullable<GraphNode["group"]>) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>, n: GraphNode) => void;
  onFocus: () => void;
}) {
  const { n } = props;
  const style = { left: n.x - props.ox, top: n.y - props.oy, width: NODE_W, height: n.h } as const;
  if (n.group) {
    return (
      <div
        role="button"
        tabIndex={props.tabbable ? 0 : -1}
        className={`tg-node group mono ${n.group.kind}`}
        style={style}
        onClick={() => n.group && props.onExpand(n.group)}
        onKeyDown={(e) => props.onKey(e, n)}
        onFocus={props.onFocus}
        data-node={n.key}
        data-testid={n.group.kind === "run" ? "tg-run-node" : "tg-group-node"}
        aria-label={n.group.kind === "run" ? `${n.group.label}: open the ${n.group.hidden} steps` : `${n.group.label}: show ${Math.min(n.group.kind === "gap" ? LANE_PAGE : PAGE, n.group.hidden)} more`}
      >
        <span className="tg-l1">{n.group.kind === "gap" ? `${n.group.label} \u25b8` : n.group.label}</span>
        {n.group.kind !== "gap" && <span className="tg-l2 muted">{n.group.kind === "run" ? n.group.detail : `click to show ${Math.min(PAGE, n.group.hidden)} more`}</span>}
      </div>
    );
  }
  const r = n.record as TraceRecord;
  const st = KIND_STYLE[r.kind as keyof typeof KIND_STYLE];
  const lines = nodeLines(r);
  const glyph = outcomeGlyph(r);
  return (
    <div
      role="button"
      tabIndex={props.tabbable ? 0 : -1}
      className={`tg-node mono${n.center ? " center" : ""}${props.selected ? " sel" : ""}${n.failed ? " failed" : ""}`}
      style={style}
      onClick={() => props.onSelect(r)}
      onDoubleClick={() => props.onRecentre(r.seq)}
      onKeyDown={(e) => props.onKey(e, n)}
      onFocus={props.onFocus}
      aria-current={n.center ? "true" : undefined}
      aria-pressed={props.selected}
      data-node={n.key}
      data-seq={r.seq}
      data-testid={n.center ? "tg-node-center" : `tg-node-${r.seq}`}
      title={r.id}
    >
      <span className="tg-l1">
        <span className="tag" style={{ color: `var(--kind-${st?.family ?? "slate"})` }}>
          [{st?.tag ?? r.kind.slice(0, 3).toUpperCase()}]
        </span>{" "}
        <span className="tg-sum">{lines.top}</span>
        {glyph !== undefined && <span className={`tg-glyph${n.failed ? " alm" : ""}`}> {glyph}</span>}
      </span>
      <span className="tg-l2 muted">{lines.bottom}</span>
    </div>
  );
}

/** The fields of a record and its JSON, for the side panel. */
function RecordFields(props: { r: TraceRecord; center: boolean }) {
  const { r } = props;
  const rows: [string, string][] = [
    ["id", r.id],
    ["time", `${r.simTime.toFixed(3)} s`],
    ["kind", r.kind],
    ["source", r.source],
    ["agent", r.agentId ?? "—"],
    ["parent", r.parentId ?? "—"],
    ["causes", r.causeIds && r.causeIds.length > 0 ? r.causeIds.join(", ") : "—"],
  ];
  return (
    <div data-testid="tg-record">
      <h4 className="sec">
        <b>{props.center ? "THIS RECORD" : "SELECTED"} · #{r.seq}</b>
        <span className="rule" />
      </h4>
      <dl className="tg-fields mono">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <pre className="tg-json mono" data-testid="tg-json">
        {JSON.stringify(r, null, 2)}
      </pre>
    </div>
  );
}

/** The node nearest in a direction: sideways, in the nearest column to the right or left (the one whose centre is closest in height); up and down, the same column. */
export function neighbour(nodes: readonly GraphNode[], from: GraphNode, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): GraphNode | undefined {
  const cy = from.y + from.h / 2;
  const candidates = nodes.filter((n) => {
    if (n.key === from.key) return false;
    if (key === "ArrowRight") return n.col > from.col;
    if (key === "ArrowLeft") return n.col < from.col;
    if (key === "ArrowDown") return n.col === from.col && n.y > from.y;
    return n.col === from.col && n.y < from.y;
  });
  const dist = (n: GraphNode) => {
    const dy = n.y + n.h / 2 - cy;
    return key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(n.col - from.col) * 100000 + Math.abs(dy) : Math.abs(dy);
  };
  return [...candidates].sort((a, b) => dist(a) - dist(b) || (a.key < b.key ? -1 : 1))[0];
}
