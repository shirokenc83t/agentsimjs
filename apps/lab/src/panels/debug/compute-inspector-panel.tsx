import "../panels.css";
import { useUiContext } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BeliefMapBytes } from "../../shell/knowledge-union.ts";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { beliefPixels, computeFacts, routeOverBelief, type Waypoint } from "./compute-view.ts";
import { buildDecisionStory, opOf, type DecisionStory } from "./decision-story.ts";
import { recordBySeq } from "./trace-tree.ts";
import { useJump } from "./use-jump.ts";

// The Compute inspector (F4 M4, T-123, the designer's LLMInspector board): one compute call of a mind: the tool, its parameters, what it found in words, the search it cost, the record and the chain it belongs
// to, and the route drawn on the map the agent *believes* in at the tick of its request (unknown cells hatched, never the ground truth). A route through hatched cells says that the agent planned through what it does not know.

const payload = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});

/** A colour of the theme, read from the page (the tokens are CSS variables; a canvas cannot use them as they are). */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "currentColor";
}

function BeliefMap(props: { map: BeliefMapBytes | undefined; resolutionM: number; route: readonly Waypoint[]; from: Waypoint | undefined; to: Waypoint | undefined; sizeCells: { x: number; y: number } | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { map, route, from, to } = props;
  const dims = map === undefined ? props.sizeCells : { x: map.sizeX, y: map.sizeY };
  useEffect(() => {
    const c = canvas.current;
    if (!c || !dims) return;
    const stride = Math.max(1, Math.ceil(Math.max(dims.x, dims.y) / 480));
    const w = Math.ceil(dims.x / stride);
    const h = Math.ceil(dims.y / stride);
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return;
    const bg = cssVar("--bg0");
    const unknown = cssVar("--bg3");
    const free = cssVar("--bg2");
    const occ = cssVar("--fg3");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    if (map !== undefined) {
      const px = beliefPixels(map, stride);
      const palette = [bg, free, occ, unknown];
      for (let y = 0; y < px.height; y++) {
        for (let x = 0; x < px.width; x++) {
          g.fillStyle = palette[px.cls[y * px.width + x] as number] as string;
          g.fillRect(x, y, 1, 1);
        }
      }
    }
    const toPx = (p: Waypoint) => [(p.xM / props.resolutionM / dims.x) * w, h - (p.yM / props.resolutionM / dims.y) * h] as const;
    if (route.length > 1) {
      g.strokeStyle = cssVar("--ac");
      g.lineWidth = Math.max(1.5, w / 200);
      g.beginPath();
      route.forEach((p, i) => (i === 0 ? g.moveTo(...toPx(p)) : g.lineTo(...toPx(p))));
      g.stroke();
    }
    const dot = (p: Waypoint | undefined, color: string) => {
      if (p === undefined) return;
      const [x, y] = toPx(p);
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, Math.max(2.5, w / 120), 0, Math.PI * 2);
      g.fill();
    };
    dot(from, cssVar("--fg"));
    dot(to, cssVar("--warn"));
  }, [map, route, from, to, dims, props.resolutionM]);
  return <canvas ref={canvas} className="compute-map" data-testid="compute-map" aria-label="The route on the map the agent believes in" />;
}

export function ComputeInspectorPanel() {
  const source = useSource();
  const { storage } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 250);
  const jump = useJump(snap);
  const picked = useUiContext((s) => s.selectedRecord);
  const runId = snap.runId;
  const seq = picked !== undefined && picked.runId === runId ? picked.seq : undefined;
  const [rec, setRec] = useState<TraceRecord | undefined | null>(null);
  const [story, setStory] = useState<DecisionStory | undefined>(undefined);
  const [map, setMap] = useState<BeliefMapBytes | undefined | "none">(undefined);
  const head = snap.persistedHeadTick ?? 0;

  useEffect(() => {
    if (runId === undefined || seq === undefined) return setRec(null);
    let live = true;
    void recordBySeq(storage.ports, runId, seq).then((r) => live && setRec(r));
    return () => {
      live = false;
    };
  }, [storage, runId, seq, head]);
  const isTool = rec !== null && rec !== undefined && rec.kind === "compute" && opOf(rec) === "tool";
  useEffect(() => {
    if (runId === undefined || rec === null || rec === undefined || !isTool) return setStory(undefined);
    let live = true;
    void buildDecisionStory(storage.ports, runId, rec.seq).then((s) => live && setStory(s));
    return () => {
      live = false;
    };
  }, [storage, runId, rec, isTool]);

  const request = story?.request;
  const tick = request === undefined ? undefined : (payload(request)["tick"] as number | undefined);
  const agentId = rec?.agentId;
  useEffect(() => {
    if (runId === undefined || agentId === undefined || tick === undefined) return setMap(undefined);
    let live = true;
    void storage.replay.beliefAt(runId, agentId, tick).then((r) => live && setMap(r.ok ? r.value : "none"));
    return () => {
      live = false;
    };
  }, [storage, runId, agentId, tick]);

  const facts = useMemo(() => (isTool && rec ? computeFacts(rec) : undefined), [isTool, rec]);
  const resolutionM = (snap.grid?.dims as { resolutionM?: number } | undefined)?.resolutionM ?? 0.5;
  const self = request === undefined ? undefined : (payload(request)["self"] as { xM?: number; yM?: number } | string | undefined);
  const from: Waypoint | undefined = typeof self === "object" && typeof self?.xM === "number" && typeof self.yM === "number" ? { xM: self.xM, yM: self.yM } : facts?.waypoints[0];
  const over = facts !== undefined && map !== undefined && map !== "none" && facts.waypoints.length > 1 ? routeOverBelief(map, resolutionM, facts.waypoints) : undefined;
  const callIndex = story === undefined || rec === null || rec === undefined ? -1 : story.calls.findIndex((c) => c.tools.some((t) => t.seq === rec.seq));
  const siblings = story === undefined ? [] : story.calls.flatMap((c) => c.tools);
  const nth = rec === null || rec === undefined ? 0 : siblings.findIndex((t) => t.seq === rec.seq) + 1;
  const prevTool = nth > 1 ? siblings[nth - 2] : undefined;
  const pick = (r: TraceRecord | undefined) => {
    if (r === undefined || runId === undefined) return;
    useUiContext.getState().selectRecord({ runId, seq: r.seq });
    jump(r.simTime, r.agentId);
  };

  if (seq === undefined) {
    return (
      <div className="panel compute-inspector" data-testid="compute-inspector">
        <p className="muted tt-empty" data-testid="compute-empty">
          No record selected · pick a compute call of a System 2 mind (a `tool` record) in the Log or in the LLM inspector.
        </p>
      </div>
    );
  }
  if (rec === null) return <div className="panel compute-inspector muted tt-empty">Reading…</div>;
  if (!isTool || facts === undefined || rec === undefined) {
    return (
      <div className="panel compute-inspector" data-testid="compute-inspector">
        <p className="muted tt-empty" data-testid="compute-not-a-tool">
          Record #{seq} is not a compute call of a mind: pick a `tool` record (the CMP lines of the LLM inspector).
        </p>
      </div>
    );
  }
  return (
    <div className="panel compute-inspector" data-testid="compute-inspector">
      <div className="llm-head">
        <b data-testid="compute-title">{facts.tool}</b> <span className="muted mono">· call {nth} of {siblings.length} in this decision · {rec.agentId}</span>
      </div>
      <BeliefMap map={map === "none" ? undefined : map} resolutionM={resolutionM} route={facts.waypoints} from={from} to={facts.to} sizeCells={undefined} />
      <p className="muted mono" data-testid="compute-belief-note">
        {rec.agentId}&apos;s own belief at tick {tick ?? "?"} · unknown hatched · never the truth
        {map === "none" ? " · the belief map of this run is not recorded: the route is drawn alone" : ""}
        {over !== undefined && over.unknownM > 0.5 ? ` · ${over.unknownM.toFixed(1)} m of the route lie over cells it has not seen` : ""}
        {over !== undefined && over.occupiedM > 0.5 ? ` · ${over.occupiedM.toFixed(1)} m over cells it believes occupied` : ""}
      </p>
      <dl className="compute-kv mono">
        <dt>tool</dt>
        <dd>{facts.tool} · compute · own belief only</dd>
        <dt>parameters</dt>
        <dd data-testid="compute-params">{JSON.stringify(facts.params)}</dd>
        <dt>result</dt>
        <dd data-testid="compute-result">
          {facts.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </dd>
        <dt>search</dt>
        <dd>{facts.expansions === undefined ? "—" : `${facts.expansions} expansion${facts.expansions === 1 ? "" : "s"}`}</dd>
        <dt>record</dt>
        <dd>
          compute #{rec.seq} · parent model call #{String(rec.parentId?.split("#")[1] ?? "")} · decision of the request #{request?.seq ?? "?"}
        </dd>
      </dl>
      <div className="llm-head">
        <button type="button" className="kt" onClick={() => pick(story?.calls[callIndex]?.record)} disabled={callIndex < 0} data-testid="compute-to-call">
          → LLM call {callIndex + 1}
        </button>
        <button type="button" className="kt" onClick={() => pick(prevTool)} disabled={prevTool === undefined} data-testid="compute-prev">
          ◂ {prevTool === undefined ? "previous tool" : String(payload(prevTool)["tool"])}
        </button>
      </div>
      <p className="muted rc-note">The model sees the result as JSON; this panel draws it on the map the agent believes in, so a path through a hatched area shows that the agent planned through what it does not know.</p>
    </div>
  );
}
