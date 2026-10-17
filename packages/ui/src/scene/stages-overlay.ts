import { BufferAttribute, BufferGeometry, Color, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial } from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { SceneTokens } from "../theme/tokens.ts";

/** Most legs a stages overlay holds (the trace thins a refine to 64 legs: ADR-0037 addition, §6) and points per line (the trace keeps at most 128 per search). */
export const MAX_STAGE_LEGS = 64;
const MAX_LINE_POINTS = 130;
/** Dashes of the coarse path (about 100 per path; room for several coarse paths). */
const MAX_COARSE_SEGMENTS = 600;
/** Joints drawn as points, and the numbered DOM labels among them. */
const MAX_JOINTS = MAX_STAGE_LEGS + 1;
const MAX_LABELS = 24;
/** Above the executed trail and planned path (0.05), the rays (0.04) and the frontier groups (0.06). */
const Y_STAGE = 0.07;
const DYNAMIC = 35048; // THREE.DynamicDrawUsage
/** About this many dashes along a coarse path, whatever its length: legible from the overview to a close look. */
const DASHES_PER_PATH = 100;
const DASH_FILL = 0.6;
/** Segments of one leg tone: half the legs, each at most `MAX_LINE_POINTS - 1`. */
const LEG_SEGMENTS_PER_TONE = (MAX_STAGE_LEGS / 2 + 1) * (MAX_LINE_POINTS - 1);

/** One drawn line: x, y pairs in sim metres. `coarse` is the abstract path of a refine (dashed); every other search is a solid leg. */
export interface StageLine {
  readonly role: "coarse" | "leg";
  readonly points: ArrayLike<number>;
}

/**
 * The coarse path as dashes: x0, y0, x1, y1 per dash into `out` (at most `out.length / 4` of them). A dashed line material
 * restarts its pattern on every segment of a segment list, so the dashes are cut here, at set time (≤ 10 Hz), and follow the
 * bends of the path. Returns the dashes written.
 */
export function dashSegments(points: ArrayLike<number>, out: Float32Array, from = 0): number {
  const n = Math.floor(points.length / 2);
  if (n < 2) return 0;
  const cum = new Float64Array(n);
  for (let k = 1; k < n; k++) cum[k] = (cum[k - 1] ?? 0) + Math.hypot((points[2 * k] ?? 0) - (points[2 * k - 2] ?? 0), (points[2 * k + 1] ?? 0) - (points[2 * k - 1] ?? 0));
  const total = cum[n - 1] ?? 0;
  if (total <= 0) return 0;
  const period = total / DASHES_PER_PATH;
  const cap = Math.floor(out.length / 4);
  let written = from;
  let edge = 0;
  for (let d = 0; d < DASHES_PER_PATH; d++) {
    let a = d * period;
    const b = a + period * DASH_FILL;
    while (a < b && written < cap) {
      while (edge < n - 2 && (cum[edge + 1] ?? 0) <= a) edge++;
      const e0 = cum[edge] ?? 0;
      const e1 = cum[edge + 1] ?? 0;
      const upTo = Math.min(b, e1);
      const len = e1 - e0;
      if (len > 0 && upTo > a) {
        const t0 = (a - e0) / len;
        const t1 = (upTo - e0) / len;
        const x0 = points[2 * edge] ?? 0;
        const y0 = points[2 * edge + 1] ?? 0;
        const dx = (points[2 * edge + 2] ?? 0) - x0;
        const dy = (points[2 * edge + 3] ?? 0) - y0;
        const o = written * 4;
        out[o] = x0 + dx * t0;
        out[o + 1] = y0 + dy * t0;
        out[o + 2] = x0 + dx * t1;
        out[o + 3] = y0 + dy * t1;
        written++;
      }
      if (upTo >= b) break;
      a = upTo;
      if (edge >= n - 2 && a >= e1) break;
      if (a === e1) edge = Math.min(edge + 1, n - 2);
    }
    if (written >= cap) break;
  }
  return written - from;
}

function segmentGeometry(vertices: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(DYNAMIC));
  g.setDrawRange(0, 0);
  return g;
}

/**
 * What a planning strategy did, drawn on the map (F2b M4, UI-SPEC "stages overlay"): the coarse path of a refine as
 * dashes, each search's path as a solid leg in one of two alternating tones, and a numbered joint where one leg ends and the
 * next begins. The same class draws the researcher's Strategy test in `sandbox` mode: every line in the sandbox tone, so a
 * sandbox path is never taken for something the run did. Colour is never the only signal: dashed = coarse, solid = legs,
 * numbers at the joints; the legend names each.
 *
 * Preallocated buffers updated in place when the selected query changes (≤ 10 Hz): nothing is allocated per frame, and every
 * input is cut at its cap rather than growing a buffer. Colours come from the scene tokens. Sim frame: x east, y north →
 * Three: x, −z.
 */
export class StagesOverlay {
  readonly group = new Group();
  private readonly coarse: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly legsEven: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly legsOdd: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly joints: Points<BufferGeometry, PointsMaterial>;
  private readonly labels: CSS2DObject[] = [];
  private readonly dash = new Float32Array(MAX_COARSE_SEGMENTS * 4);
  private readonly jointXY = new Float32Array(MAX_JOINTS * 2);
  private tokens: SceneTokens;
  private coarseDashes = 0;
  private legCount = 0;
  private evenSegments = 0;
  private oddSegments = 0;
  private jointCount = 0;
  private legsInEven = 0;
  private legsInOdd = 0;

  constructor(
    tokens: SceneTokens,
    readonly kind: "run" | "sandbox",
  ) {
    this.tokens = tokens;
    this.coarse = new LineSegments(segmentGeometry(MAX_COARSE_SEGMENTS * 2), new LineBasicMaterial({ color: new Color(this.coarseColor()) }));
    this.legsEven = new LineSegments(segmentGeometry(LEG_SEGMENTS_PER_TONE * 2), new LineBasicMaterial({ color: new Color(this.evenColor()) }));
    this.legsOdd = new LineSegments(segmentGeometry(LEG_SEGMENTS_PER_TONE * 2), new LineBasicMaterial({ color: new Color(this.oddColor()) }));
    const jg = new BufferGeometry();
    jg.setAttribute("position", new BufferAttribute(new Float32Array(MAX_JOINTS * 3), 3).setUsage(DYNAMIC));
    jg.setDrawRange(0, 0);
    this.joints = new Points(jg, new PointsMaterial({ color: new Color(this.evenColor()), size: 7, sizeAttenuation: false }));
    for (const o of [this.coarse, this.legsEven, this.legsOdd, this.joints]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
    for (let k = 0; k < MAX_LABELS; k++) {
      const el = document.createElement("span");
      el.className = "stage-joint mono";
      el.style.display = "none";
      const o = new CSS2DObject(el);
      o.visible = false;
      this.labels.push(o);
      this.group.add(o);
    }
  }

  private coarseColor(): string {
    return this.kind === "sandbox" ? this.tokens.stageSandbox : this.tokens.stageCoarse;
  }
  private evenColor(): string {
    return this.kind === "sandbox" ? this.tokens.stageSandbox : this.tokens.stageLeg;
  }
  private oddColor(): string {
    return this.kind === "sandbox" ? this.tokens.stageSandbox : this.tokens.stageLegAlt;
  }

  /** Sets the lines to draw, or clears with `undefined`. Called when the selected query changes, never per frame. */
  setStages(lines: readonly StageLine[] | undefined): void {
    let dashes = 0;
    let legs = 0;
    let even = 0;
    let odd = 0;
    let legsEvenN = 0;
    let legsOddN = 0;
    let joints = 0;
    const ep = this.legsEven.geometry.getAttribute("position") as BufferAttribute;
    const op = this.legsOdd.geometry.getAttribute("position") as BufferAttribute;
    const jp = this.joints.geometry.getAttribute("position") as BufferAttribute;
    for (const line of lines ?? []) {
      const n = Math.min(MAX_LINE_POINTS, Math.floor(line.points.length / 2));
      if (n < 2) continue;
      if (line.role === "coarse") {
        dashes += dashSegments(Array.prototype.slice.call(line.points, 0, n * 2) as number[], this.dash.subarray(dashes * 4), 0);
        continue;
      }
      if (legs >= MAX_STAGE_LEGS) continue;
      // The sandbox has one tone: every leg goes to the first buffer.
      const toEven = this.kind === "sandbox" || legs % 2 === 0;
      const attr = toEven ? ep : op;
      let segments = toEven ? even : odd;
      for (let k = 0; k + 1 < n && segments < LEG_SEGMENTS_PER_TONE; k++) {
        attr.setXYZ(segments * 2, line.points[2 * k] ?? 0, Y_STAGE, -(line.points[2 * k + 1] ?? 0));
        attr.setXYZ(segments * 2 + 1, line.points[2 * k + 2] ?? 0, Y_STAGE, -(line.points[2 * k + 3] ?? 0));
        segments++;
      }
      if (toEven) {
        even = segments;
        legsEvenN++;
      } else {
        odd = segments;
        legsOddN++;
      }
      // A joint is where the previous leg ended: this leg's first point (the legs of a refine join end to end).
      if (legs > 0 && joints < MAX_JOINTS) {
        const x = line.points[0] ?? 0;
        const y = line.points[1] ?? 0;
        this.jointXY[joints * 2] = x;
        this.jointXY[joints * 2 + 1] = y;
        jp.setXYZ(joints, x, Y_STAGE, -y);
        joints++;
      }
      legs++;
    }
    this.coarseDashes = dashes;
    this.legCount = legs;
    this.evenSegments = even;
    this.oddSegments = odd;
    this.legsInEven = legsEvenN;
    this.legsInOdd = legsOddN;
    this.jointCount = joints;
    const cp = this.coarse.geometry.getAttribute("position") as BufferAttribute;
    for (let k = 0; k < dashes; k++) {
      cp.setXYZ(k * 2, this.dash[k * 4] ?? 0, Y_STAGE, -(this.dash[k * 4 + 1] ?? 0));
      cp.setXYZ(k * 2 + 1, this.dash[k * 4 + 2] ?? 0, Y_STAGE, -(this.dash[k * 4 + 3] ?? 0));
    }
    for (const a of [cp, ep, op, jp]) a.needsUpdate = true;
    this.coarse.geometry.setDrawRange(0, dashes * 2);
    this.legsEven.geometry.setDrawRange(0, even * 2);
    this.legsOdd.geometry.setDrawRange(0, odd * 2);
    this.joints.geometry.setDrawRange(0, joints);
    // Joints are numbered where there is room: 1 is the joint after the first leg.
    for (let k = 0; k < MAX_LABELS; k++) {
      const o = this.labels[k];
      if (!o) continue;
      const on = k < joints;
      o.visible = on;
      o.element.style.display = on ? "" : "none";
      if (on) {
        o.element.textContent = String(k + 1);
        o.position.set(this.jointXY[k * 2] ?? 0, Y_STAGE, -(this.jointXY[k * 2 + 1] ?? 0));
      }
    }
  }

  applyTheme(t: SceneTokens): void {
    this.tokens = t;
    this.coarse.material.color.set(this.coarseColor());
    this.legsEven.material.color.set(this.evenColor());
    this.legsOdd.material.color.set(this.oddColor());
    this.joints.material.color.set(this.evenColor());
  }

  /** What is drawn now (diagnostics and e2e). */
  counts(): { coarseDashes: number; legs: number; legSegments: number; joints: number; labels: number } {
    return { coarseDashes: this.coarseDashes, legs: this.legCount, legSegments: this.evenSegments + this.oddSegments, joints: this.jointCount, labels: Math.min(this.jointCount, MAX_LABELS) };
  }

  /** The numbers shown at the joints, in order. */
  jointNumbers(): number[] {
    return Array.from({ length: Math.min(this.jointCount, MAX_LABELS) }, (_, k) => k + 1);
  }

  /** The joints in sim metres. */
  jointPositions(): [number, number][] {
    return Array.from({ length: this.jointCount }, (_, k) => [this.jointXY[k * 2] ?? 0, this.jointXY[k * 2 + 1] ?? 0]);
  }

  /** Legs drawn in each of the two tones (the sandbox has one). */
  legTonesInUse(): { even: number; odd: number } {
    return { even: this.legsInEven, odd: this.legsInOdd };
  }

  /** The drawn vertices of the even-tone legs, in Three's frame (diagnostics and tests). */
  legPositions(): number[] {
    const a = this.legsEven.geometry.getAttribute("position") as BufferAttribute;
    return Array.from((a.array as Float32Array).subarray(0, this.evenSegments * 2 * 3));
  }

  /** Bytes held in the geometry buffers: constant for the overlay's life (nothing grows). */
  bufferBytes(): number {
    let total = this.dash.byteLength + this.jointXY.byteLength;
    for (const o of [this.coarse, this.legsEven, this.legsOdd, this.joints]) total += (o.geometry.getAttribute("position") as BufferAttribute).array.byteLength;
    return total;
  }

  dispose(): void {
    for (const o of [this.coarse, this.legsEven, this.legsOdd, this.joints]) {
      o.geometry.dispose();
      o.material.dispose();
    }
    for (const l of this.labels) l.element.remove();
  }
}
