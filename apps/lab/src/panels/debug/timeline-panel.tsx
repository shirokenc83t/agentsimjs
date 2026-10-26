import "../panels.css";
import { KIND_STYLE, useTheme, useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useAppActions, usePolled, useSource } from "../../services.tsx";
import { gapLabel } from "../../sim/gap-click.ts";
import { DerivedTag } from "./derived-tag.tsx";
import { BIN_PX, binMarks, describeAt, flagRole, GLYPH_PX, glyphOf, isFailure, nearestMark, type Mark } from "./marks.ts";
import { useDockPanel } from "../../workspaces/panel-context.ts";
import { foldLabel, foldLanes, FOLD_LANE } from "./lane-fold.ts";
import { LABEL_PX, LANE_PX, laneAt, RULER_PX, rulerTicks, selectionFromDrag } from "./timeline-geometry.ts";
import { useJump } from "./use-jump.ts";
import { useRunMarks } from "./use-run-marks.ts";

/**
 * The Timeline of the Debug workspace (UI-SPEC §6, ADR-0016): one lane per agent with the marks of what happened to it (actions, reflexes, injected
 * commands, degradations; the run's snapshots and checkpoints on a lane of their own), the cursor, and for a live run what is not saved yet, hatched.
 * A click on a mark moves the shared cursor to it (and selects its agent); a click elsewhere to that moment, through the gap rule. A drag on the ruler selects a range
 * of time (Esc clears it) that "Re-simulate this window" uses. Drawn on a canvas,
 * and the cursor is read imperatively: dragging does not re-render the panel.
 */
export function TimelinePanel() {
  const theme = useTheme().resolved; // the colours are the tokens read when drawing: drawn again when the theme changes
  const source = useSource();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const dt = snap.run?.dtS ?? 0.1;
  const headS = (snap.persistedHeadTick ?? 0) * dt;
  const simHeadS = Math.max(headS, snap.simHeadTick * dt);
  const scale = Math.max(simHeadS, dt);
  const marks = useRunMarks(snap.runId, headS);
  const [emptyOpen, setEmptyOpen] = useState(false);
  // The agents with no marks take one row until it is opened.
  const folded = useMemo(() => foldLanes(["run", ...snap.entityIds], marks, emptyOpen), [snap.entityIds, marks, emptyOpen]);
  const lanes = folded.lanes;
  const jump = useJump(snap);
  const { resimulateWindow } = useAppActions();
  const startS = snap.replay?.startS ?? 0;
  const selection = useUiContext((s) => s.timeSelection);
  /** The drag in progress: where it began and where it is (px from the canvas's left edge), or none. */
  const drag = useRef<{ from: number; to: number; moved: boolean } | undefined>(undefined);
  const dragged = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const height = RULER_PX + lanes.length * LANE_PX;
  // The panel's window is as tall as what it holds (its header, the ruler and its lanes): no empty band under folded lanes, and no scrollbar. Done when the number of lanes
  // changes, and only for a docked window; what the researcher drags afterwards stays until the lanes change again.
  const dock = useDockPanel();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!dock || !el || dock.api.location.type === "floating") return;
    let tries = 0;
    let raf = 0;
    // The dock lays the window out over a few frames after a size is asked (and a first, narrower answer may be overtaken by the next): ask again until it is the size it was asked for.
    const fit = () => {
      if (dock.api.isMaximized() || el.clientHeight === 0) return;
      const needed = (el.querySelector(".timeline-head")?.getBoundingClientRect().height ?? 26) + height + 6;
      const delta = Math.round(needed - el.clientHeight);
      const cap = Math.round(dock.containerApi.height * 0.5);
      if (Math.abs(delta) <= 6 || tries++ >= 6) return;
      dock.api.group.api.setSize({ height: Math.min(cap, Math.max(90, dock.api.group.api.height + delta)) });
      raf = requestAnimationFrame(() => (raf = requestAnimationFrame(fit)));
    };
    raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [dock, lanes.length, height]);
  const label = gapLabel(snap.persistedHeadTick ?? 0, snap.simHeadTick, dt);
  const reflexes = marks.filter((m) => m.kind === "reflex").length;
  const failures = marks.filter(isFailure).length;

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const css = getComputedStyle(c);
    const color = (name: string) => css.getPropertyValue(name).trim() || "currentColor";
    const mono = css.getPropertyValue("--font-mono").trim() || "monospace";
    const track = width - LABEL_PX;
    const x = (t: number) => LABEL_PX + (t / scale) * track;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `11px ${mono}`;
    ctx.textBaseline = "middle";
    // The seconds ruler.
    ctx.fillStyle = color("--bg1");
    ctx.fillRect(0, 0, width, RULER_PX);
    ctx.fillStyle = color("--ln");
    ctx.fillRect(0, RULER_PX - 1, width, 1);
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
      ctx.fillStyle = color("--bg0");
      ctx.fillRect(LABEL_PX, y, track, LANE_PX);
      if (i % 2 === 1) {
        ctx.fillStyle = color("--bg1");
        ctx.globalAlpha = 0.6;
        ctx.fillRect(LABEL_PX, y, track, LANE_PX);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = color("--bg1");
      ctx.fillRect(0, y, LABEL_PX, LANE_PX);
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
    // What is stored, and what is not yet (hatched).
    ctx.fillStyle = color("--acbg");
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x(startS), RULER_PX, Math.max(0, x(headS) - x(startS)), height - RULER_PX);
    ctx.globalAlpha = 1;
    if (simHeadS > headS) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x(headS), RULER_PX, x(simHeadS) - x(headS), height - RULER_PX);
      ctx.clip();
      ctx.strokeStyle = color("--ln2");
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = x(headS) - height; gx < x(simHeadS); gx += 6) {
        ctx.moveTo(gx, height);
        ctx.lineTo(gx + height, RULER_PX);
      }
      ctx.stroke();
      ctx.restore();
    }
    // Marks: failures and reflexes (the flags) each where they are, never counted; the others in fixed bins of 32 px (one glyph, a count that fits, or a density bar where a flag
    // takes the count's place, the counts then in the tooltip). The glyph is the kind (never colour alone).
    const binned = binMarks(marks, lanes, scale, track, BIN_PX);
    for (const b of binned.bins) {
      const m = b.shown;
      const family = KIND_STYLE[m.kind as keyof typeof KIND_STYLE]?.family ?? "slate";
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
        if (b.label.glyph) ctx.fillText(glyphOf(m), LABEL_PX + b.label.x + GLYPH_PX / 2, cy);
        ctx.fillStyle = color("--fg2");
        ctx.textAlign = "left";
        ctx.fillText(b.label.text, LABEL_PX + b.label.x + (b.label.glyph ? GLYPH_PX + 2 : 0), cy);
      } else {
        ctx.textAlign = "center";
        ctx.fillText(glyphOf(m), LABEL_PX + b.gx, cy);
      }
    }
    for (const f of binned.flags) {
      const m = f.mark;
      const role = flagRole(m);
      const cx = LABEL_PX + f.px;
      ctx.fillStyle = role === "alarm" ? color("--alm") : color("--warn");
      ctx.fillRect(Math.round(cx) - 1, RULER_PX + f.lane * LANE_PX, 2, LANE_PX - 1);
      ctx.textAlign = "center";
      ctx.fillText(glyphOf(m), LABEL_PX + f.gx, RULER_PX + f.lane * LANE_PX + LANE_PX / 2);
    }
    ctx.textAlign = "left";
    // The selected range: a tint over the lanes and a band on the ruler with its ends (the one being dragged is read now, like the cursor).
    const live = drag.current && drag.current.moved ? selectionFromDrag(drag.current.from, drag.current.to, width, scale) : useUiContext.getState().timeSelection;
    if (live) {
      const x0 = x(live.t0S);
      const x1 = x(live.t1S);
      ctx.fillStyle = color("--ac");
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x0, RULER_PX, x1 - x0, height - RULER_PX);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x0, 0, x1 - x0, RULER_PX - 1);
      ctx.globalAlpha = 1;
      ctx.fillRect(Math.round(x0), 0, 1, height);
      ctx.fillRect(Math.round(x1) - 1, 0, 1, height);
    }
    // The cursor, read now (never a React value), with its label.
    const t = Math.min(useUiContext.getState().simTime, simHeadS);
    ctx.fillStyle = color("--ac");
    ctx.fillRect(Math.round(x(t)) - 1, 0, 2, height);
    const text = `t ${t.toFixed(1)} s`;
    const w = ctx.measureText(text).width + 8;
    const lx = Math.min(width - w, Math.round(x(t)) + 3);
    ctx.fillRect(lx, 1, w, RULER_PX - 3);
    ctx.fillStyle = color("--acfg");
    ctx.fillText(text, lx + 4, RULER_PX / 2 - 1);
  }, [width, height, lanes, marks, scale, headS, simHeadS, startS, theme, emptyOpen, folded.empty.length]);

  useEffect(() => {
    draw();
    let last = useUiContext.getState().simTime;
    let lastSel = useUiContext.getState().timeSelection;
    return useUiContext.subscribe((s) => {
      if (s.simTime === last && s.timeSelection === lastSel) return;
      last = s.simTime;
      lastSel = s.timeSelection;
      requestAnimationFrame(draw);
    });
  }, [draw]);

  const px = (e: PointerEvent<HTMLCanvasElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  // A drag that begins on the ruler selects a range; a press that does not move is the click it always was.
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (e.button !== 0 || e.clientY - box.top >= RULER_PX || px(e) < LABEL_PX) return;
    drag.current = { from: px(e), to: px(e), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.parentElement?.parentElement?.focus();
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) {
      // What is under the pointer, in words: a flag, or the counts of a bin.
      const box = e.currentTarget.getBoundingClientRect();
      const lane = laneAt(e.clientY - box.top, lanes.length);
      const at = e.clientX - box.left - LABEL_PX;
      e.currentTarget.title = lane >= 0 && at >= 0 ? describeAt(binMarks(marks, lanes, scale, width - LABEL_PX, BIN_PX), lane, at) : "";
      return;
    }
    d.to = px(e);
    if (Math.abs(d.to - d.from) >= 3) d.moved = true;
    if (d.moved) requestAnimationFrame(draw);
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = undefined;
    if (!d) return;
    d.to = px(e);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) return; // a click: the click handler takes it
    dragged.current = true; // the click that follows a drag is not a jump
    useUiContext.getState().setTimeSelection(selectionFromDrag(d.from, d.to, width, scale));
    requestAnimationFrame(draw);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && useUiContext.getState().timeSelection !== undefined) {
      e.stopPropagation();
      useUiContext.getState().setTimeSelection(undefined);
    }
  };

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const lane = laneAt(e.clientY - box.top, lanes.length);
    if (lane >= 0 && lanes[lane] === FOLD_LANE) {
      setEmptyOpen((o) => !o);
      return;
    }
    const t = Math.max(0, Math.min(scale, ((px - LABEL_PX) / (width - LABEL_PX)) * scale));
    // A mark within 5 px of the click on that lane is what was clicked (the ruler picks none).
    const picked: Mark | undefined = px >= LABEL_PX && lane >= 0 ? nearestMark(marks, lanes, lane, t, (5 / (width - LABEL_PX)) * scale) : undefined;
    setNotice(picked ? jump(picked.t, picked.agentId) : jump(t, lane > 0 ? lanes[lane] : undefined));
  };

  return (
    <div ref={root} className="panel timeline" data-testid="timeline" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="timeline-head">
        <span className="muted">{marks.length} marks</span>
        <DerivedTag derived={snap.replay?.derived} />
        <span data-testid="timeline-counts" className="mono">
          <span className={reflexes > 0 ? "warn" : "attn-zero"}>▲ {reflexes} reflex</span> · <span className={failures > 0 ? "danger" : "attn-zero"}>✕ {failures} failure</span>
        </span>
        <span className="sp" />
        {selection !== undefined && (
          <span className="mono" data-testid="timeline-selection" title="Esc clears the selection">
            selected {selection.t0S.toFixed(1)}–{selection.t1S.toFixed(1)} s
          </span>
        )}
        <button
          type="button"
          className="btn"
          disabled={!snap.runId}
          onClick={resimulateWindow}
          data-tip={selection !== undefined ? "Re-simulate the selected window into a derived run" : "Re-simulate the cursor with a few seconds either side into a derived run (drag on the ruler to choose the window)"}
          data-testid="timeline-resim"
        >
          Re-simulate<span className="lbl-long"> this window</span>
        </button>
        {label !== undefined && (
          <span className="warn" data-testid="timeline-gap">
            {label}
          </span>
        )}
        {notice !== undefined && (
          <span className="muted" data-testid="timeline-notice">
            {notice}
          </span>
        )}
      </div>
      <div className="timeline-lanes">
        <canvas ref={canvas} width={width} height={height} style={{ width, height }} onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} data-testid="timeline-canvas" aria-label="Timeline: one lane per agent" />
      </div>
    </div>
  );
}
