import "../panels.css";
import { KIND_STYLE, useTheme } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { foldLabel, foldLanes, FOLD_LANE } from "../debug/lane-fold.ts";
import { BIN_PX, binMarks, describeAt, flagRole, GLYPH_PX, glyphOf, type Mark } from "../debug/marks.ts";
import { LABEL_PX, LANE_PX, RULER_PX, rulerTicks, selectionFromDrag } from "../debug/timeline-geometry.ts";

export interface AnalysisTimelineProps {
  /** The lanes: the run's own, then one per agent shown. */
  readonly lanes: readonly string[];
  readonly marks: readonly Mark[];
  /** The span of the run in sim seconds. */
  readonly scaleS: number;
  /** The window selected (the filter's `t:` term), or none. */
  readonly window: { readonly t0: number; readonly t1: number } | undefined;
  /** The shared cursor. */
  readonly cursorS: number;
  /** A drag on the ruler selects a window; a click on the ruler's selection... clears it with `undefined`. */
  readonly onBrush: (w: { readonly t0: number; readonly t1: number } | undefined) => void;
  /** A click on a lane or the ruler moves the shared cursor (to the nearest mark within a few pixels, else to where it is). */
  readonly onSeek: (tS: number, agentId?: string, mark?: Mark) => void;
}

/**
 * The event timeline of the Analysis workspace (ADR-0029): a lane per agent with its events (a glyph for one, a count or a density bar for many, the flags ✕ and ▲ never
 * folded), the shared cursor, and the **brush**: a drag on the ruler selects a window, which is the filter's `t:` term and moves the other views with it.
 */
export function AnalysisTimeline(props: AnalysisTimelineProps) {
  const theme = useTheme().resolved; // the colours are the tokens read when drawing: drawn again when the theme changes
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const drag = useRef<{ from: number; to: number; moved: boolean } | undefined>(undefined);
  const dragged = useRef(false);
  // The agents with no marks take one row until it is opened.
  const [emptyOpen, setEmptyOpen] = useState(false);
  const folded = useMemo(() => foldLanes(props.lanes, props.marks, emptyOpen), [props.lanes, props.marks, emptyOpen]);
  const lanes = folded.lanes;
  const height = RULER_PX + lanes.length * LANE_PX;
  const scale = Math.max(props.scaleS, 0.1);

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const css = getComputedStyle(c);
    const color = (n: string) => css.getPropertyValue(n).trim() || "currentColor";
    const track = width - LABEL_PX;
    const x = (t: number) => LABEL_PX + (t / scale) * track;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `11px ${css.getPropertyValue("--font-mono").trim() || "monospace"}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = color("--bg1");
    ctx.fillRect(0, 0, width, RULER_PX);
    ctx.textAlign = "center";
    for (const tick of rulerTicks(scale, track)) {
      const tx = Math.round(x(tick.t));
      ctx.fillStyle = color("--ln");
      ctx.fillRect(tx, RULER_PX - 4, 1, 4);
      ctx.fillStyle = color("--fg3");
      ctx.fillText(tick.label, Math.min(width - 14, Math.max(LABEL_PX + 14, tx)), RULER_PX / 2 - 1);
    }
    ctx.textAlign = "left";
    lanes.forEach((lane, i) => {
      const y = RULER_PX + i * LANE_PX;
      ctx.fillStyle = i % 2 === 0 ? color("--bg0") : color("--bg1");
      ctx.fillRect(0, y, width, LANE_PX);
      ctx.fillStyle = color("--ln");
      ctx.fillRect(0, y + LANE_PX - 1, width, 1);
      if (lane === FOLD_LANE) {
        ctx.fillStyle = color("--fg3");
        ctx.fillText(foldLabel(folded.empty.length, emptyOpen), 8, y + LANE_PX / 2);
        return;
      }
      ctx.fillStyle = color("--fg2");
      ctx.fillText(lane, 8, y + LANE_PX / 2);
    });
    ctx.fillStyle = color("--ln");
    ctx.fillRect(LABEL_PX - 1, RULER_PX, 1, height - RULER_PX);
    const binned = binMarks(props.marks, lanes, scale, track, BIN_PX);
    for (const b of binned.bins) {
      const family = KIND_STYLE[b.shown.kind as keyof typeof KIND_STYLE]?.family ?? "slate";
      const cy = RULER_PX + b.lane * LANE_PX + LANE_PX / 2;
      ctx.fillStyle = color(`--kind-${family}`);
      if (b.mode === "bar") {
        const h = Math.max(3, Math.round(((LANE_PX - 5) * b.count) / binned.maxCount));
        ctx.globalAlpha = 0.85;
        ctx.fillRect(LABEL_PX + b.x0 + 2, RULER_PX + (b.lane + 1) * LANE_PX - 2 - h, BIN_PX - 4, h);
        ctx.globalAlpha = 1;
        continue;
      }
      if (b.mode === "count" && b.label) {
        // The label is laid out to fit the bin: the glyph and the count, or the count alone, centred in it.
        ctx.textAlign = "center";
        if (b.label.glyph) ctx.fillText(glyphOf(b.shown), LABEL_PX + b.label.x + GLYPH_PX / 2, cy);
        ctx.fillStyle = color("--fg2");
        ctx.textAlign = "left";
        ctx.fillText(b.label.text, LABEL_PX + b.label.x + (b.label.glyph ? GLYPH_PX + 2 : 0), cy);
      } else {
        ctx.textAlign = "center";
        ctx.fillText(glyphOf(b.shown), LABEL_PX + b.gx, cy);
      }
      ctx.textAlign = "left";
    }
    for (const f of binned.flags) {
      const role = flagRole(f.mark);
      const cx = LABEL_PX + f.px;
      ctx.fillStyle = role === "alarm" ? color("--alm") : color("--warn");
      ctx.fillRect(Math.round(cx) - 1, RULER_PX + f.lane * LANE_PX, 2, LANE_PX - 1);
      ctx.textAlign = "center";
      ctx.fillText(glyphOf(f.mark), LABEL_PX + f.gx, RULER_PX + f.lane * LANE_PX + LANE_PX / 2);
      ctx.textAlign = "left";
    }
    const live = drag.current?.moved ? selectionFromDrag(drag.current.from, drag.current.to, width, scale) : props.window === undefined ? undefined : { t0S: props.window.t0, t1S: props.window.t1 };
    if (live) {
      const x0 = x(Math.max(0, live.t0S));
      const x1 = x(Math.min(scale, live.t1S));
      ctx.fillStyle = color("--ac");
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x0, RULER_PX, x1 - x0, height - RULER_PX);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x0, 0, x1 - x0, RULER_PX - 1);
      ctx.globalAlpha = 1;
      ctx.fillRect(Math.round(x0), 0, 1, height);
      ctx.fillRect(Math.round(x1) - 1, 0, 1, height);
    }
    const t = Math.min(props.cursorS, scale);
    ctx.fillStyle = color("--ac");
    ctx.fillRect(Math.round(x(t)) - 1, 0, 2, height);
  }, [width, height, scale, emptyOpen, folded.empty.length, lanes, props.marks, props.window, props.cursorS, theme]);

  useEffect(() => draw(), [draw]);

  const px = (e: PointerEvent<HTMLCanvasElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (e.button !== 0 || e.clientY - box.top >= RULER_PX || px(e) < LABEL_PX) return;
    drag.current = { from: px(e), to: px(e), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d) {
      d.to = px(e);
      if (Math.abs(d.to - d.from) >= 3) d.moved = true;
      if (d.moved) requestAnimationFrame(draw);
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const lane = Math.floor((e.clientY - box.top - RULER_PX) / LANE_PX);
    const at = px(e) - LABEL_PX;
    e.currentTarget.title = lane >= 0 && lane < lanes.length && at >= 0 ? describeAt(binMarks(props.marks, lanes, scale, width - LABEL_PX, BIN_PX), lane, at) : "";
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = undefined;
    if (!d) return;
    d.to = px(e);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) return;
    dragged.current = true;
    const sel = selectionFromDrag(d.from, d.to, width, scale);
    props.onBrush(sel === undefined ? undefined : { t0: sel.t0S, t1: sel.t1S });
  };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const row = Math.floor((e.clientY - box.top - RULER_PX) / LANE_PX);
    if (row >= 0 && lanes[row] === FOLD_LANE) {
      setEmptyOpen((o) => !o);
      return;
    }
    if (x < LABEL_PX) return;
    const t = Math.max(0, Math.min(scale, ((x - LABEL_PX) / (width - LABEL_PX)) * scale));
    const lane = Math.floor((e.clientY - box.top - RULER_PX) / LANE_PX);
    const agent = lane > 0 && lane < lanes.length ? lanes[lane] : undefined;
    // The mark of that lane within a few pixels is what was clicked.
    let near: Mark | undefined;
    if (lane >= 0 && lane < lanes.length) {
      const tol = (5 / (width - LABEL_PX)) * scale;
      let bestD = tol;
      for (const m of props.marks) {
        const l = m.agentId === undefined ? 0 : lanes.indexOf(m.agentId);
        if ((l < 0 ? 0 : l) !== lane) continue;
        const d = Math.abs(m.t - t);
        if (d <= bestD) {
          near = m;
          bestD = d;
        }
      }
    }
    props.onSeek(near ? near.t : t, near?.agentId ?? agent, near);
  };

  return (
    <div className="atl" data-testid="analysis-timeline">
      <canvas
        ref={canvas}
        width={width}
        height={height}
        style={{ width, height }}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        data-testid="analysis-timeline-canvas"
        aria-label="Event timeline: one lane per agent; drag on the ruler to select a window"
      />
    </div>
  );
}
