import { TRAIL_MAX_POINTS, TRAIL_STRIDE } from "@agentsim/core";
import { BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, LineDashedMaterial } from "three";

/** Planned and executed paths float just above the ground so the atlas never hides them. */
const PATH_Y = 0.05;

/** An agent's executed path from the sim: `count` points (x, y, z each) and the version of its last replace. */
export interface ExecutedPathView {
  readonly points: ArrayLike<number>;
  readonly count: number;
  readonly version: number;
}

interface AgentPaths {
  planned: Line<BufferGeometry, LineDashedMaterial> | undefined;
  trail: Line<BufferGeometry, LineBasicMaterial>;
  trailPos: Float32Array;
  /** Points drawn, and the path version they come from. */
  trailCount: number;
  trailVersion: number;
  color: string;
}

/**
 * Planned vs executed paths per agent (ROADMAP F1 UI): planned = dashed line of the agent's latest plan,
 * executed = solid line of where it actually went. Same agent colour, told apart by line style (and the
 * legend), never by colour alone. Executed points come from the simulation's tick states (the worker
 * records them), never from rendered positions, so every viewer sees the same line.
 *
 * Bounded (F2 M1b): each trail is preallocated for `TRAIL_MAX_POINTS`; new points upload only their range
 * (`addUpdateRange`); when the worker thins a trail (a new version), it is rebuilt and uploaded whole.
 */
export class PathLayer {
  readonly group = new Group();
  private readonly agents = new Map<string, AgentPaths>();

  /** Registers an agent (its colour); idempotent. */
  ensure(agentId: string, color: string): void {
    const a = this.agents.get(agentId);
    if (a) {
      if (a.color !== color) this.recolor(a, color);
      return;
    }
    const trailPos = new Float32Array(TRAIL_MAX_POINTS * 3);
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(trailPos, 3));
    geom.setDrawRange(0, 0);
    const trail = new Line(geom, new LineBasicMaterial({ color }));
    trail.frustumCulled = false;
    this.group.add(trail);
    this.agents.set(agentId, { planned: undefined, trail, trailPos, trailCount: 0, trailVersion: 0, color });
  }

  private recolor(a: AgentPaths, color: string): void {
    a.color = color;
    a.trail.material.color.set(color);
    a.planned?.material.color.set(color);
  }

  /** Sets (or clears, with an empty list) the agent's planned path, in sim metres. Called on change only. */
  setPlanned(agentId: string, waypoints: readonly (readonly [number, number])[]): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    if (a.planned) {
      this.group.remove(a.planned);
      a.planned.geometry.dispose();
      a.planned.material.dispose();
      a.planned = undefined;
    }
    if (waypoints.length < 2) return;
    const pos = new Float32Array(waypoints.length * 3);
    waypoints.forEach(([x, y], k) => pos.set([x, PATH_Y, -y], k * 3));
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(pos, 3));
    const line = new Line(geom, new LineDashedMaterial({ color: a.color, dashSize: 0.6, gapSize: 0.4 }));
    line.computeLineDistances();
    line.frustumCulled = false;
    this.group.add(line);
    a.planned = line;
  }

  /**
   * Brings the agent's executed trail up to `path`: appends the points not drawn yet, or rebuilds the trail when
   * its version changed (the worker replaced it). Called when the worker sends points (≤ 10 Hz), never per frame.
   */
  setExecuted(agentId: string, path: ExecutedPathView): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    const total = Math.min(path.count, TRAIL_MAX_POINTS);
    const attr = a.trail.geometry.getAttribute("position") as BufferAttribute;
    if (path.version !== a.trailVersion || total < a.trailCount) {
      this.write(a, path.points, 0, total);
      attr.clearUpdateRanges(); // whole-buffer upload
      attr.needsUpdate = true;
      a.trailVersion = path.version;
    } else if (total > a.trailCount) {
      this.write(a, path.points, a.trailCount, total);
      attr.addUpdateRange(a.trailCount * 3, (total - a.trailCount) * 3);
      attr.needsUpdate = true;
    } else return;
    a.trailCount = total;
    a.trail.geometry.setDrawRange(0, total);
  }

  private write(a: AgentPaths, points: ArrayLike<number>, from: number, to: number): void {
    const pos = a.trailPos;
    for (let k = from; k < to; k++) {
      const s = k * TRAIL_STRIDE;
      const o = k * 3;
      pos[o] = points[s] ?? 0;
      pos[o + 1] = PATH_Y;
      pos[o + 2] = -(points[s + 1] ?? 0);
    }
  }

  /** The executed trail's geometry (diagnostics and tests). */
  executedGeometry(agentId: string): BufferGeometry | undefined {
    return this.agents.get(agentId)?.trail.geometry;
  }

  /** Vertex counts (diagnostics and e2e): planned path and executed trail. */
  counts(agentId: string): { planned: number; executed: number } {
    const a = this.agents.get(agentId);
    if (!a) return { planned: 0, executed: 0 };
    return { planned: a.planned ? a.planned.geometry.getAttribute("position").count : 0, executed: a.trailCount };
  }

  /** Forgets every agent (a new run). */
  clear(): void {
    for (const a of this.agents.values()) {
      if (a.planned) {
        a.planned.geometry.dispose();
        a.planned.material.dispose();
      }
      a.trail.geometry.dispose();
      a.trail.material.dispose();
    }
    this.group.clear();
    this.agents.clear();
  }
}
