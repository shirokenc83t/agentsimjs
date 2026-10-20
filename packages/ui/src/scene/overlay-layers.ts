import { BufferAttribute, BufferGeometry, CanvasTexture, Color, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial } from "three";
import type { SceneTokens } from "../theme/tokens.ts";

/** Most rays, regions and frontier groups the overlays hold (the worker decimates and caps to these). */
export const MAX_RAYS = 256;
export const MAX_REGIONS = 256;
export const MAX_FRONTIERS = 64;

/** Most targets of each kind the exploration overlay holds (the view cuts to these, newest kept). */
export const MAX_EXPLORE_MARKS = 64;
/** The glyphs of the two kinds of marked targets: a diamond (set aside for the iteration) and a cross (marked unreachable). */
const GLYPH_TEMPORARY = "\u25c7";
const GLYPH_PERMANENT = "\u2715";
/** Segments of the ring that marks the radius of an exploration iteration. */
const RING_SEGMENTS = 64;

/**
 * What the exploration overlay draws (ADR-0040): the iteration in progress as a ring of its radius around its centre, a cross at the centre and
 * the square of its search window; the targets set aside for the iteration (`temporary`, x and y pairs in sim metres) and the targets marked
 * unreachable for good (`permanent`).
 */
export interface ExplorationView {
  readonly area?: { readonly x: number; readonly y: number; readonly radiusM: number; readonly window: readonly [number, number, number, number] };
  readonly temporary: ArrayLike<number>;
  readonly permanent: ArrayLike<number>;
}

/** A glyph in a colour (a token) on a transparent canvas; undefined where there is no canvas (tests without a DOM). */
function glyphTexture(glyph: string, color: string): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined;
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const g = c.getContext("2d");
  if (!g) return undefined;
  g.fillStyle = color;
  g.font = "bold 28px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(glyph, 16, 17);
  return new CanvasTexture(c);
}

/** Heights above the ground atlas (m): regions, then rays, then frontier markers; under paths (0.05) and agents. */
const Y_REGION = 0.03;
const Y_RAY = 0.04;
const Y_FRONTIER = 0.06;
/** THREE.DynamicDrawUsage. */
const DYNAMIC = 35048;

function lineGeometry(vertices: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(DYNAMIC));
  g.setDrawRange(0, 0);
  return g;
}

/**
 * The viewed agent's sensor rays, topological regions and frontier groups (F2 M2e6): preallocated buffers updated in
 * place when a worker message arrives (≤ 10 Hz), so nothing is allocated per frame. Colours come from the existing scene
 * tokens: rays that hit the accent, rays that reached their range the dim tint, regions the grid line colour, frontier
 * groups the amber of "unknown", frontier groups marked unreachable the impassable red (the legend names each: colour is
 * never the only signal). Sim frame: x east, y north → Three: x, −z.
 */
export class SensorOverlay {
  readonly group = new Group();
  private readonly rays: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly regions: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly frontiers: Points<BufferGeometry, PointsMaterial>;
  private readonly rayColors = new Float32Array(MAX_RAYS * 2 * 3);
  private readonly frontierColors = new Float32Array(MAX_FRONTIERS * 3);
  private rayHit = new Uint8Array(0);
  private frontierMarked = new Uint8Array(0);
  private area: LineSegments<BufferGeometry, LineBasicMaterial> | undefined;
  private temporary: Points<BufferGeometry, PointsMaterial> | undefined;
  private permanent: Points<BufferGeometry, PointsMaterial> | undefined;
  private exploreCounts = { area: 0, temporary: 0, permanent: 0 };
  private tokens: SceneTokens;
  private rayCount = 0;
  private regionCount = 0;
  private frontierCount = 0;

  constructor(tokens: SceneTokens) {
    this.tokens = tokens;
    const rg = lineGeometry(MAX_RAYS * 2);
    rg.setAttribute("color", new BufferAttribute(this.rayColors, 3).setUsage(DYNAMIC));
    this.rays = new LineSegments(rg, new LineBasicMaterial({ vertexColors: true }));
    this.regions = new LineSegments(lineGeometry(MAX_REGIONS * 8), new LineBasicMaterial({ color: new Color(tokens.gridMajor) }));
    const fg = new BufferGeometry();
    fg.setAttribute("position", new BufferAttribute(new Float32Array(MAX_FRONTIERS * 3), 3).setUsage(DYNAMIC));
    fg.setAttribute("color", new BufferAttribute(this.frontierColors, 3).setUsage(DYNAMIC));
    fg.setDrawRange(0, 0);
    this.frontiers = new Points(fg, new PointsMaterial({ size: 10, sizeAttenuation: false, vertexColors: true }));
    for (const o of [this.rays, this.regions, this.frontiers]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
  }

  /** Sets the rays (x0, y0, x1, y1 per ray; `hit` per ray) or clears them with `undefined`. */
  setRays(segments: Float32Array | undefined, hit: Uint8Array | undefined): void {
    const n = segments && hit ? Math.min(MAX_RAYS, hit.length, Math.floor(segments.length / 4)) : 0;
    const pos = this.rays.geometry.getAttribute("position") as BufferAttribute;
    for (let k = 0; k < n; k++) {
      const s = segments as Float32Array;
      pos.setXYZ(k * 2, s[k * 4] ?? 0, Y_RAY, -(s[k * 4 + 1] ?? 0));
      pos.setXYZ(k * 2 + 1, s[k * 4 + 2] ?? 0, Y_RAY, -(s[k * 4 + 3] ?? 0));
    }
    this.rayHit = n > 0 ? (hit as Uint8Array).slice(0, n) : new Uint8Array(0);
    this.rayCount = n;
    this.colorRays();
    pos.needsUpdate = true;
    this.rays.geometry.setDrawRange(0, n * 2);
  }

  /** Sets the regions (x0, y0, x1, y1 m, known %) and frontier groups (x, y, cells, marked) or clears them. */
  setTopology(regions: Float32Array | undefined, frontiers: Float32Array | undefined): void {
    const nr = regions ? Math.min(MAX_REGIONS, Math.floor(regions.length / 5)) : 0;
    const rp = this.regions.geometry.getAttribute("position") as BufferAttribute;
    for (let k = 0; k < nr; k++) {
      const r = regions as Float32Array;
      const x0 = r[k * 5] ?? 0;
      const y0 = -(r[k * 5 + 1] ?? 0);
      const x1 = r[k * 5 + 2] ?? 0;
      const y1 = -(r[k * 5 + 3] ?? 0);
      const o = k * 8;
      rp.setXYZ(o, x0, Y_REGION, y0);
      rp.setXYZ(o + 1, x1, Y_REGION, y0);
      rp.setXYZ(o + 2, x1, Y_REGION, y0);
      rp.setXYZ(o + 3, x1, Y_REGION, y1);
      rp.setXYZ(o + 4, x1, Y_REGION, y1);
      rp.setXYZ(o + 5, x0, Y_REGION, y1);
      rp.setXYZ(o + 6, x0, Y_REGION, y1);
      rp.setXYZ(o + 7, x0, Y_REGION, y0);
    }
    rp.needsUpdate = true;
    this.regionCount = nr;
    this.regions.geometry.setDrawRange(0, nr * 8);
    const nf = frontiers ? Math.min(MAX_FRONTIERS, Math.floor(frontiers.length / 4)) : 0;
    const fp = this.frontiers.geometry.getAttribute("position") as BufferAttribute;
    const marked = new Uint8Array(nf);
    for (let k = 0; k < nf; k++) {
      const f = frontiers as Float32Array;
      fp.setXYZ(k, f[k * 4] ?? 0, Y_FRONTIER, -(f[k * 4 + 1] ?? 0));
      marked[k] = (f[k * 4 + 3] ?? 0) > 0.5 ? 1 : 0;
    }
    this.frontierMarked = marked;
    this.frontierCount = nf;
    this.colorFrontiers();
    fp.needsUpdate = true;
    this.frontiers.geometry.setDrawRange(0, nf);
  }

  /**
   * Sets what exploration draws (ADR-0040), or clears it with `undefined`. The layers are built on first use. A ring (the radius of the iteration,
   * its centre crossed, its window squared) and two kinds of targets that differ by shape as well as colour: a diamond (amber) for the ones set
   * aside for the iteration, a cross (red) for the ones marked unreachable for good.
   */
  setExploration(view: ExplorationView | undefined): void {
    if (!view && !this.area) return;
    if (!this.area) {
      this.area = new LineSegments(lineGeometry((RING_SEGMENTS + 2 + 4) * 2), new LineBasicMaterial({ color: new Color(this.tokens.selection) }));
      const mark = (): Points<BufferGeometry, PointsMaterial> => {
        const g = new BufferGeometry();
        g.setAttribute("position", new BufferAttribute(new Float32Array(MAX_EXPLORE_MARKS * 3), 3).setUsage(DYNAMIC));
        g.setDrawRange(0, 0);
        return new Points(g, new PointsMaterial({ size: 16, sizeAttenuation: false, transparent: true, alphaTest: 0.2 }));
      };
      this.temporary = mark();
      this.permanent = mark();
      this.colorMarks();
      for (const o of [this.area, this.temporary, this.permanent]) {
        o.frustumCulled = false;
        this.group.add(o);
      }
    }
    const area = this.area;
    const temporary = this.temporary as Points<BufferGeometry, PointsMaterial>;
    const permanent = this.permanent as Points<BufferGeometry, PointsMaterial>;
    const ap = area.geometry.getAttribute("position") as BufferAttribute;
    let v = 0;
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      ap.setXYZ(v++, x0, Y_FRONTIER, -y0);
      ap.setXYZ(v++, x1, Y_FRONTIER, -y1);
    };
    const a = view?.area;
    if (a) {
      for (let k = 0; k < RING_SEGMENTS; k++) {
        const t0 = (k / RING_SEGMENTS) * 2 * Math.PI;
        const t1 = ((k + 1) / RING_SEGMENTS) * 2 * Math.PI;
        line(a.x + a.radiusM * Math.cos(t0), a.y + a.radiusM * Math.sin(t0), a.x + a.radiusM * Math.cos(t1), a.y + a.radiusM * Math.sin(t1));
      }
      const arm = Math.max(0.5, a.radiusM * 0.03);
      line(a.x - arm, a.y, a.x + arm, a.y);
      line(a.x, a.y - arm, a.x, a.y + arm);
      const [x0, y0, x1, y1] = a.window;
      line(x0, y0, x1, y0);
      line(x1, y0, x1, y1);
      line(x1, y1, x0, y1);
      line(x0, y1, x0, y0);
    }
    ap.needsUpdate = true;
    area.geometry.setDrawRange(0, v);
    const put = (points: Points<BufferGeometry, PointsMaterial>, xy: ArrayLike<number> | undefined): number => {
      const total = xy ? Math.floor(xy.length / 2) : 0;
      const n = Math.min(MAX_EXPLORE_MARKS, total);
      const skip = total - n; // the newest are kept
      const p = points.geometry.getAttribute("position") as BufferAttribute;
      for (let k = 0; k < n; k++) p.setXYZ(k, xy?.[2 * (skip + k)] ?? 0, Y_FRONTIER, -(xy?.[2 * (skip + k) + 1] ?? 0));
      p.needsUpdate = true;
      points.geometry.setDrawRange(0, n);
      return n;
    };
    this.exploreCounts = { area: a ? 1 : 0, temporary: put(temporary, view?.temporary), permanent: put(permanent, view?.permanent) };
  }

  /** The marks' glyphs are drawn in the token colours (a canvas has no tint of its own), again when the theme changes. */
  private colorMarks(): void {
    const set = (points: Points<BufferGeometry, PointsMaterial> | undefined, glyph: string, color: string) => {
      if (!points) return;
      const map = glyphTexture(glyph, color);
      points.material.map?.dispose();
      points.material.map = map ?? null;
      if (!map) points.material.color.set(color); // no canvas: the points are plain squares in the colour
      points.material.needsUpdate = true;
    };
    set(this.temporary, GLYPH_TEMPORARY, this.tokens.unknownHeight);
    set(this.permanent, GLYPH_PERMANENT, this.tokens.impassable);
  }

  private colorRays(): void {
    const hit = new Color(this.tokens.selection);
    const miss = new Color(this.tokens.pathPlannedDim);
    for (let k = 0; k < this.rayCount; k++) {
      const c = this.rayHit[k] === 1 ? hit : miss;
      this.rayColors.set([c.r, c.g, c.b, c.r, c.g, c.b], k * 6);
    }
    (this.rays.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
  }

  private colorFrontiers(): void {
    const open = new Color(this.tokens.unknownHeight);
    const marked = new Color(this.tokens.impassable);
    for (let k = 0; k < this.frontierCount; k++) {
      const c = this.frontierMarked[k] === 1 ? marked : open;
      this.frontierColors.set([c.r, c.g, c.b], k * 3);
    }
    (this.frontiers.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
  }

  applyTheme(t: SceneTokens): void {
    this.tokens = t;
    this.regions.material.color.set(t.gridMajor);
    this.colorRays();
    this.colorFrontiers();
    this.area?.material.color.set(t.selection);
    this.colorMarks();
  }

  /** What is drawn now (diagnostics and e2e). */
  counts(): { rays: number; regions: number; frontiers: number; markedFrontiers: number; exploration: { area: number; temporary: number; permanent: number } } {
    let marked = 0;
    for (let k = 0; k < this.frontierCount; k++) marked += this.frontierMarked[k] ?? 0;
    return { rays: this.rayCount, regions: this.regionCount, frontiers: this.frontierCount, markedFrontiers: marked, exploration: { ...this.exploreCounts } };
  }

  dispose(): void {
    for (const o of [this.rays, this.regions, this.frontiers, ...(this.area ? [this.area] : []), ...(this.temporary ? [this.temporary] : []), ...(this.permanent ? [this.permanent] : [])]) {
      o.geometry.dispose();
      o.material.dispose();
    }
  }
}
