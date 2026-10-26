import "./panels.css";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useScene } from "./scene-handle.ts";

/** How often the Overview is drawn (ms): a few times a second, from its own timer, never from the Scene's frame loop. */
const REDRAW_MS = 250;

/**
 * The Overview window (ADR-0042 section 8): the whole map at low resolution, drawn from the grid and belief atlases the Scene already holds (not a second 3D view),
 * with the agents and the main view's frame on it. A click moves the main view there. Drawn only while the window is open.
 */
export function OverviewPanel() {
  const scene = useScene();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useRef<{ scale: number; ox: number; oy: number; sizeXM: number; sizeYM: number } | undefined>(undefined);
  const [size, setSize] = useState({ w: 220, h: 160 });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(60, Math.floor(el.clientWidth)), h: Math.max(40, Math.floor(el.clientHeight)) }));
    ro.observe(el);
    setSize({ w: Math.max(60, Math.floor(el.clientWidth)), h: Math.max(40, Math.floor(el.clientHeight)) });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const draw = () => {
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      // A collapsed window is display:none: nothing to draw for.
      if (!c || !ctx || !scene || c.offsetParent === null) return;
      layout.current = scene.drawOverview(ctx, size.w, size.h);
    };
    draw();
    const t = setInterval(draw, REDRAW_MS);
    return () => clearInterval(t);
  }, [scene, size]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const l = layout.current;
    if (!scene || !l) return;
    const box = e.currentTarget.getBoundingClientRect();
    const xM = (e.clientX - box.left - l.ox) / l.scale;
    const yM = (l.oy - (e.clientY - box.top)) / l.scale;
    if (xM >= 0 && yM >= 0 && xM <= l.sizeXM && yM <= l.sizeYM) scene.panTo(xM, yM);
  };

  return (
    <div className="overview-panel" ref={host} data-testid="overview">
      <canvas ref={canvas} width={size.w} height={size.h} onClick={onClick} aria-label="Overview of the whole map: click to move the view there" data-testid="overview-canvas" />
    </div>
  );
}
