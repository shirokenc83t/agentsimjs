import { BufferAttribute, BufferGeometry, Color, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial } from "three";
import type { SceneTokens } from "../theme/tokens.ts";

/** Most rays, regions and frontier groups the overlays hold (the worker decimates and caps to these). */
export const MAX_RAYS = 256;
export const MAX_REGIONS = 256;
export const MAX_FRONTIERS = 64;

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
  }

  /** What is drawn now (diagnostics and e2e). */
  counts(): { rays: number; regions: number; frontiers: number; markedFrontiers: number } {
    let marked = 0;
    for (let k = 0; k < this.frontierCount; k++) marked += this.frontierMarked[k] ?? 0;
    return { rays: this.rayCount, regions: this.regionCount, frontiers: this.frontierCount, markedFrontiers: marked };
  }

  dispose(): void {
    for (const o of [this.rays, this.regions, this.frontiers]) {
      o.geometry.dispose();
      o.material.dispose();
    }
  }
}
