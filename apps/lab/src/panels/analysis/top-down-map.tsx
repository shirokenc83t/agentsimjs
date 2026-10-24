import "../panels.css";
import { identityOf, KIND_STYLE, shortLabel } from "@agentsim/ui";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { mapTransform, thinMarkers, type MapMarker, type MapModel, type MapPalette } from "./analysis-model.ts";

/** What a click on the map picks: an event (its record), a moment on an agent's trajectory, or nothing. */
export interface MapPick {
  readonly seq?: number;
  readonly t?: number;
  readonly agentId?: string;
}

export interface TopDownMapHandle {
  /** The map as it is drawn, as a PNG. */
  toPng(): Promise<Blob | undefined>;
  /** The palette the page resolves from its tokens (for the SVG export, which has no stylesheet). */
  palette(): MapPalette;
}

export interface TopDownMapProps {
  readonly model: MapModel;
  /** The agent the panels are looking at: its line is drawn heavier. */
  readonly selectedAgent?: string | undefined;
  /** The event picked (shared with the log): its marker is ringed. */
  readonly selectedSeq?: number | undefined;
  readonly onPick?: ((p: MapPick) => void) | undefined;
  readonly label: string;
  /** Whether the events are drawn on the paths (the Analysis workspace's markers chip); on by default. */
  readonly markers?: boolean;
}

const PICK_PX = 9;

/** The largest 1, 2 or 5 x 10^k at most `m` (a round length for a scale bar). */
export function niceLength(m: number): number {
  if (!(m > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [5, 2, 1]) if (f * p <= m) return f * p;
  return p;
}

/** System colours, for a page that has no theme loaded (a test): the tokens are the colours. */
const FALLBACK: MapPalette = { background: "Canvas", obstacle: "GrayText", text: "CanvasText", alarm: "CanvasText", warning: "CanvasText", agent: ["CanvasText"] };

/** The page's colours as values: tokens of the active theme (the canvas has no stylesheet either). */
function readPalette(el: Element): MapPalette {
  const css = getComputedStyle(el);
  const c = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const agent: string[] = [];
  for (let i = 0; i < 8; i++) agent.push(c(`--agent-${i}`, "currentColor"));
  const kind: Record<string, string> = {};
  for (const s of Object.values(KIND_STYLE)) kind[s.family] ??= c(`--kind-${s.family}`, "currentColor");
  return { background: c("--bg0", FALLBACK.background), obstacle: c("--ln2", FALLBACK.obstacle), text: c("--fg", FALLBACK.text), alarm: c("--alm", FALLBACK.alarm), warning: c("--warn", FALLBACK.warning), agent, kind };
}

/**
 * The top-down map (UI-SPEC section 4, ADR-0029): the world seen from above, north up, the blocked cells, the trajectories of the agents, where they are and the events
 * on them (glyphs by kind, ✕ and ▲ the flags), on a canvas (no WebGL: it works under software GL). It is a function of its model: the Analysis workspace feeds it a recorded
 * run, the Scene's 2D tab the run it shows. A click on an event or on a trajectory is a pick (a record, a moment); the picture can be exported.
 */
export const TopDownMap = forwardRef<TopDownMapHandle, TopDownMapProps>(function TopDownMap(props, ref) {
  const { model } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | undefined>(undefined);

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const measure = () => setSize({ w: Math.max(80, Math.round(el.clientWidth)), h: Math.max(80, Math.round(el.clientHeight)) });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const tf = useMemo(() => mapTransform(model, size.w, size.h), [model, size]);
  // The events drawn: the flags always, the plain ones thinned when they are many (and none when the chip is off).
  const drawn = useMemo<readonly MapMarker[]>(() => (props.markers === false ? [] : thinMarkers(model.markers, tf.px, tf.py)), [model.markers, tf, props.markers]);

  // The blocked cells as one small image, scaled up without smoothing (a cell is a cell).
  const base = useMemo(() => {
    const b = model.blocked;
    if (!b || typeof document === "undefined") return undefined;
    const c = document.createElement("canvas");
    c.width = b.cols;
    c.height = b.rows;
    return { canvas: c, b };
  }, [model.blocked]);

  const draw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const started = performance.now();
    const pal = readPalette(c);
    const mono = getComputedStyle(c).getPropertyValue("--font-mono").trim() || "monospace";
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = pal.background;
    ctx.fillRect(0, 0, size.w, size.h);
    // The world's extent.
    ctx.strokeStyle = pal.obstacle;
    ctx.lineWidth = 1;
    ctx.strokeRect(tf.px(0) + 0.5, tf.py(model.heightM) + 0.5, model.widthM * tf.scale, model.heightM * tf.scale);
    if (base) {
      const bctx = base.canvas.getContext("2d");
      if (bctx) {
        const img = bctx.createImageData(base.b.cols, base.b.rows);
        const rgba = pal.obstacle.startsWith("#") ? [parseInt(pal.obstacle.slice(1, 3), 16), parseInt(pal.obstacle.slice(3, 5), 16), parseInt(pal.obstacle.slice(5, 7), 16)] : [90, 100, 110];
        for (let j = 0; j < base.b.rows; j++)
          for (let i = 0; i < base.b.cols; i++) {
            const k = ((base.b.rows - 1 - j) * base.b.cols + i) * 4; // row 0 is y = 0: the bottom
            const on = base.b.cells[j * base.b.cols + i] ? 255 : 0;
            img.data[k] = rgba[0] ?? 90;
            img.data[k + 1] = rgba[1] ?? 100;
            img.data[k + 2] = rgba[2] ?? 110;
            img.data[k + 3] = on;
          }
        bctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(base.canvas, tf.px(0), tf.py(model.heightM), model.widthM * tf.scale, model.heightM * tf.scale);
      }
    }
    // Trajectories.
    for (const t of model.trajectories) {
      if (t.points.length < 2) continue;
      ctx.strokeStyle = pal.agent[t.colorIndex % pal.agent.length] ?? pal.text;
      ctx.lineWidth = t.agentId === props.selectedAgent ? 2.5 : 1.25;
      ctx.beginPath();
      t.points.forEach((p, i) => (i === 0 ? ctx.moveTo(tf.px(p.x), tf.py(p.y)) : ctx.lineTo(tf.px(p.x), tf.py(p.y))));
      ctx.stroke();
    }
    // Events on the paths: a 4 px dot in the colour of the kind with a ring of the background, the flags 12 px on top of them, and a ring on the one picked.
    const sorted = [...drawn.filter((m) => m.role === undefined), ...drawn.filter((m) => m.role !== undefined)];
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const m of sorted) {
      const x = tf.px(m.x);
      const y = tf.py(m.y);
      if (m.role === undefined) {
        ctx.fillStyle = pal.background;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = pal.kind?.[KIND_STYLE[m.kind as keyof typeof KIND_STYLE]?.family ?? "slate"] ?? pal.text;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.font = `bold 12px ${mono}`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.background;
        ctx.strokeText(m.glyph, x, y);
        ctx.fillStyle = m.role === "alarm" ? pal.alarm : pal.warning;
        ctx.fillText(m.glyph, x, y);
      }
      if (m.seq === props.selectedSeq) {
        ctx.strokeStyle = pal.text;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.font = `11px ${mono}`;
    // Where the agents are: the marker style of their identity (solid, outline, dashed), the short label beside it.
    for (const a of model.positions) {
      const id = identityOf(a.colorIndex);
      const col = pal.agent[id.colorIndex % pal.agent.length] ?? pal.text;
      const x = tf.px(a.x);
      const y = tf.py(a.y);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      if (id.style === "solid") {
        ctx.fillStyle = col;
        ctx.fill();
      } else {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.setLineDash(id.style === "dashed" ? [2, 2] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = pal.text;
      ctx.textAlign = "left";
      ctx.fillText(shortLabel(a.agentId), x + 8, y - 8);
      ctx.textAlign = "center";
    }
    // A scale bar (a round length of about 100 px) bottom left, and north top right: a map has both.
    const nice = niceLength(100 / tf.scale);
    const barPx = nice * tf.scale;
    const bx = tf.px(0) + 6;
    const by = tf.py(0) - 8;
    ctx.font = `11px ${mono}`;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pal.text;
    ctx.fillStyle = pal.text;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + barPx, by);
    ctx.lineTo(bx + barPx, by - 4);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + 2, by - 10);
    ctx.textAlign = "center";
    const nx = tf.px(model.widthM) - 14;
    const ny = tf.py(model.heightM) + 26;
    ctx.beginPath();
    ctx.moveTo(nx, ny);
    ctx.lineTo(nx, ny - 14);
    ctx.moveTo(nx - 3, ny - 10);
    ctx.lineTo(nx, ny - 15);
    ctx.lineTo(nx + 3, ny - 10);
    ctx.stroke();
    ctx.fillText("N", nx, ny + 7);
    // The probe of the benches: how long a draw took (with the page's probe on, nothing otherwise).
    const probe = window.__agentsim;
    if (probe) {
      const list = (probe.map2dMs ??= []);
      list.push(performance.now() - started);
      if (list.length > 2000) list.splice(0, list.length - 2000);
    }
  }, [model, size, tf, base, drawn, props.selectedAgent, props.selectedSeq]);

  useEffect(() => {
    draw();
  }, [draw]);

  useImperativeHandle(
    ref,
    () => ({
      toPng: () => new Promise<Blob | undefined>((resolve) => (canvas.current ? canvas.current.toBlob((b) => resolve(b ?? undefined), "image/png") : resolve(undefined))),
      palette: () => (canvas.current ? readPalette(canvas.current) : FALLBACK),
    }),
    [],
  );

  /** What is under the pointer: an event within a few pixels, else the nearest sample of a trajectory within a few pixels. */
  const hit = useCallback(
    (clientX: number, clientY: number): { pick: MapPick; text: string } | undefined => {
      const box = canvas.current?.getBoundingClientRect();
      if (!box) return undefined;
      const x = clientX - box.left;
      const y = clientY - box.top;
      let best: { d: number; pick: MapPick; text: string } | undefined;
      const consider = (d: number, pick: MapPick, text: string) => {
        if (d <= PICK_PX && (!best || d < best.d)) best = { d, pick, text };
      };
      for (const a of model.positions) consider(Math.hypot(tf.px(a.x) - x, tf.py(a.y) - y) - 3, { agentId: a.agentId }, a.agentId);
      for (const m of drawn) consider(Math.hypot(tf.px(m.x) - x, tf.py(m.y) - y) - 2, { seq: m.seq, t: m.t, agentId: m.agentId }, m.label);
      if (!best) {
        for (const t of model.trajectories)
          for (const p of t.points) if (p.t !== undefined) consider(Math.hypot(tf.px(p.x) - x, tf.py(p.y) - y), { t: p.t, agentId: t.agentId }, `${t.agentId} at ${p.t.toFixed(1)} s`);
      }
      return best;
    },
    [model, tf, drawn],
  );

  return (
    <div className="tdm" data-testid="map2d">
      <canvas
        ref={canvas}
        width={size.w}
        height={size.h}
        style={{ width: size.w, height: size.h }}
        role="img"
        aria-label={props.label}
        data-testid="map2d-canvas"
        data-markers={model.markers.length}
        data-trajectories={model.trajectories.length}
        onClick={(e) => {
          const h = hit(e.clientX, e.clientY);
          if (h) props.onPick?.(h.pick);
        }}
        onPointerMove={(e) => {
          const h = hit(e.clientX, e.clientY);
          const box = e.currentTarget.getBoundingClientRect();
          setHover(h ? { x: e.clientX - box.left, y: e.clientY - box.top, text: h.text } : undefined);
        }}
        onPointerLeave={() => setHover(undefined)}
      />
      {/* The agents on the map as a list of buttons, for the keyboard and for a screen reader (a canvas has no parts): each is the agent's place, a pick selects it. */}
      <ul className="tdm-agents" aria-label="Agents on the map">
        {model.positions.map((a) => (
          <li key={a.agentId}>
            <button type="button" onClick={() => props.onPick?.({ agentId: a.agentId })} data-testid={`map2d-agent-${a.agentId}`}>
              {a.agentId} at {a.x.toFixed(1)} m, {a.y.toFixed(1)} m
            </button>
          </li>
        ))}
      </ul>
      {hover && (
        <div className="tdm-tip mono" style={{ left: Math.min(hover.x + 12, size.w - 160), top: hover.y + 12 }} data-testid="map2d-tip">
          {hover.text}
        </div>
      )}
    </div>
  );
});
