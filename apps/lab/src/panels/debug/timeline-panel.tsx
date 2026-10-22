import "../panels.css";
import { KIND_STYLE, useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { usePolled, useSource } from "../../services.tsx";
import { gapLabel } from "../../sim/gap-click.ts";
import { collapseMarks, glyphOf, isFailure, nearestMark, type Mark } from "./marks.ts";
import { LABEL_PX, LANE_PX, laneAt, MERGE_PX, RULER_PX, rulerTicks } from "./timeline-geometry.ts";
import { useJump } from "./use-jump.ts";
import { useRunMarks } from "./use-run-marks.ts";

/**
 * The Timeline of the Debug workspace (UI-SPEC §6, ADR-0016): one lane per agent with the marks of what happened to it (actions, reflexes, injected
 * commands, degradations; the run's snapshots and checkpoints on a lane of their own), the cursor, and for a live run what is not saved yet, hatched.
 * A click on a mark moves the shared cursor to it (and selects its agent); a click elsewhere to that moment, through the gap rule. Drawn on a canvas,
 * and the cursor is read imperatively: dragging does not re-render the panel.
 */
export function TimelinePanel() {
  const source = useSource();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 100);
  const dt = snap.run?.dtS ?? 0.1;
  const headS = (snap.persistedHeadTick ?? 0) * dt;
  const simHeadS = Math.max(headS, snap.simHeadTick * dt);
  const scale = Math.max(simHeadS, dt);
  const marks = useRunMarks(snap.runId, headS);
  const lanes = useMemo(() => ["run", ...snap.entityIds], [snap.entityIds]);
  const jump = useJump(snap);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const height = RULER_PX + lanes.length * LANE_PX;
  const label = gapLabel(snap.persistedHeadTick ?? 0, snap.simHeadTick, dt);

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
      ctx.fillStyle = color("--fg2");
      ctx.fillText(lane, 8, y + LANE_PX / 2);
    });
    ctx.fillStyle = color("--ln");
    ctx.fillRect(LABEL_PX - 1, RULER_PX, 1, height - RULER_PX);
    // What is stored, and what is not yet (hatched).
    ctx.fillStyle = color("--acbg");
    ctx.globalAlpha = 0.35;
    ctx.fillRect(LABEL_PX, RULER_PX, Math.max(0, x(headS) - LABEL_PX), height - RULER_PX);
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
    // Marks as glyphs in the kind's hue (a failure ✕ in the alarm colour); marks too close to tell apart are one glyph with a count (never colour alone: the glyph is the kind).
    ctx.textAlign = "center";
    for (const cl of collapseMarks(marks, lanes, scale, track, MERGE_PX)) {
      const m = cl.shown;
      const family = KIND_STYLE[m.kind as keyof typeof KIND_STYLE]?.family ?? "slate";
      const cx = LABEL_PX + cl.px;
      const cy = RULER_PX + cl.lane * LANE_PX + LANE_PX / 2;
      ctx.fillStyle = isFailure(m) ? color("--alm") : color(`--kind-${family}`);
      ctx.fillText(glyphOf(m), cx, cy);
      if (cl.count > 1) {
        ctx.fillStyle = color("--fg2");
        ctx.textAlign = "left";
        ctx.fillText(`×${cl.count}`, cx + 6, cy);
        ctx.textAlign = "center";
      }
    }
    ctx.textAlign = "left";
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
  }, [width, height, lanes, marks, scale, headS, simHeadS]);

  useEffect(() => {
    draw();
    let last = useUiContext.getState().simTime;
    return useUiContext.subscribe((s) => {
      if (s.simTime === last) return;
      last = s.simTime;
      requestAnimationFrame(draw);
    });
  }, [draw]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const lane = laneAt(e.clientY - box.top, lanes.length);
    const t = Math.max(0, Math.min(scale, ((px - LABEL_PX) / (width - LABEL_PX)) * scale));
    // A mark within 5 px of the click on that lane is what was clicked (the ruler picks none).
    const picked: Mark | undefined = px >= LABEL_PX && lane >= 0 ? nearestMark(marks, lanes, lane, t, (5 / (width - LABEL_PX)) * scale) : undefined;
    setNotice(picked ? jump(picked.t, picked.agentId) : jump(t, lane > 0 ? lanes[lane] : undefined));
  };

  return (
    <div className="panel timeline" data-testid="timeline">
      <div className="timeline-head">
        <span className="muted">{marks.length} marks</span>
        <span data-testid="timeline-counts" className="mono">
          <span style={{ color: "var(--kind-pink)" }}>▲ {marks.filter((m) => m.kind === "reflex").length} reflex</span> · <span className="danger">✕ {marks.filter(isFailure).length} failure</span>
        </span>
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
        <canvas ref={canvas} width={width} height={height} style={{ width, height }} onClick={onClick} data-testid="timeline-canvas" aria-label="Timeline: one lane per agent" />
      </div>
    </div>
  );
}
