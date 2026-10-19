import "../panels.css";
import { KIND_STYLE, useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { usePolled, useSource } from "../../services.tsx";
import { gapLabel } from "../../sim/gap-click.ts";
import { laneIndex, nearestMark, type Mark } from "./marks.ts";
import { useJump } from "./use-jump.ts";
import { useRunMarks } from "./use-run-marks.ts";

const LANE_PX = 20;
const LABEL_PX = 84;

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
  const height = lanes.length * LANE_PX;
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
    const track = width - LABEL_PX;
    const x = (t: number) => LABEL_PX + (t / scale) * track;
    ctx.clearRect(0, 0, width, height);
    ctx.font = "11px monospace";
    ctx.textBaseline = "middle";
    lanes.forEach((lane, i) => {
      const y = i * LANE_PX;
      ctx.fillStyle = i % 2 === 0 ? color("--bg2") : color("--bg1");
      ctx.fillRect(LABEL_PX, y, track, LANE_PX);
      ctx.fillStyle = color("--fg2");
      ctx.fillText(lane, 4, y + LANE_PX / 2);
    });
    // What is stored, and what is not yet (hatched).
    ctx.fillStyle = color("--acbg");
    ctx.globalAlpha = 0.35;
    ctx.fillRect(LABEL_PX, 0, Math.max(0, x(headS) - LABEL_PX), height);
    ctx.globalAlpha = 1;
    if (simHeadS > headS) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x(headS), 0, x(simHeadS) - x(headS), height);
      ctx.clip();
      ctx.strokeStyle = color("--ln");
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = x(headS) - height; gx < x(simHeadS); gx += 6) {
        ctx.moveTo(gx, height);
        ctx.lineTo(gx + height, 0);
      }
      ctx.stroke();
      ctx.restore();
    }
    // Marks, a kind's hue and a 2 px tick (a mark's kind is also in the list's tag: colour is never the only signal).
    for (const m of marks) {
      const style = KIND_STYLE[m.kind as keyof typeof KIND_STYLE];
      ctx.fillStyle = color(`--kind-${style?.family ?? "slate"}`);
      const y = laneIndex(lanes, m) * LANE_PX;
      ctx.fillRect(Math.round(x(m.t)) - 1, y + 3, 2, LANE_PX - 6);
    }
    // The cursor, read now (never a React value).
    const t = Math.min(useUiContext.getState().simTime, simHeadS);
    ctx.fillStyle = color("--ac");
    ctx.fillRect(Math.round(x(t)) - 1, 0, 2, height);
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
    const lane = Math.min(lanes.length - 1, Math.max(0, Math.floor((e.clientY - box.top) / LANE_PX)));
    const t = Math.max(0, Math.min(scale, ((px - LABEL_PX) / (width - LABEL_PX)) * scale));
    // A mark within 5 px of the click on that lane is what was clicked.
    const picked: Mark | undefined = px >= LABEL_PX ? nearestMark(marks, lanes, lane, t, (5 / (width - LABEL_PX)) * scale) : undefined;
    setNotice(picked ? jump(picked.t, picked.agentId) : jump(t, lane > 0 ? lanes[lane] : undefined));
  };

  return (
    <div className="panel timeline" data-testid="timeline">
      <div className="timeline-head">
        <span className="muted">{marks.length} marks</span>
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
