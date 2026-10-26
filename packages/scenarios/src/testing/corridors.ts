import { compileCostProfile, GridSearch, PlanningService, SearchSpace, smoothPath } from "@agentsim/algorithms";
import { ActionRuntime, defaultReflexes, detmath, PurePursuit, Rng, stepUgv, type PursuitParams, type SimAgent, type TraceSink, type UgvState } from "@agentsim/core";
import { DEFAULT_TOPOLOGY, GridSpace, OCCUPANCY_BLOCKED, OCCUPANCY_FREE } from "@agentsim/spatial";
import { GridSpatialAdapter, PlanningServiceAdapter, toolsSchemaCapabilities } from "../assemble/adapters.ts";
import type { ResolvedUgvBody } from "../body-defaults.ts";
import type { EffectiveAgentConfig } from "../run-config/resolve.ts";

/**
 * Seeded corridor worlds for tracking property tests: a blocked map with a corridor carved along a random
 * polyline (corners and hairpins), wide enough for the vehicle to turn at its minimum radius.
 */
export interface Corridor {
  readonly grid: GridSpace;
  readonly start: readonly [number, number];
  readonly startHeading: number;
  readonly goal: readonly [number, number];
  /** Largest absolute turn angle along the skeleton (radians). */
  readonly sharpestTurn: number;
}

const RES = 0.5;
const SIZE_M = 100;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0;
  const dx = ax + t * ex - px;
  const dy = ay + t * ey - py;
  return Math.sqrt(dx * dx + dy * dy);
}

export function generateCorridor(rng: Rng, widthM: readonly [number, number] = [4.5, 7]): Corridor {
  for (;;) {
    const width = widthM[0] + rng.nextFloat01() * (widthM[1] - widthM[0]);
    const pts: [number, number][] = [[15 + rng.nextFloat01() * 10, 15 + rng.nextFloat01() * 70]];
    let heading = (rng.nextFloat01() - 0.5) * Math.PI;
    const startHeading = heading;
    const n = rng.intRange(2, 4);
    let sharpest = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (k > 0) {
        const turn = (rng.nextFloat01() * 2 - 1) * (170 * Math.PI) / 180;
        sharpest = Math.max(sharpest, Math.abs(turn));
        heading += turn;
      }
      const len = 10 + rng.nextFloat01() * 8;
      const [x, y] = pts[pts.length - 1] ?? [0, 0];
      const nx = x + len * detmath.cos(heading);
      const ny = y + len * detmath.sin(heading);
      if (nx < 8 || ny < 8 || nx > SIZE_M - 8 || ny > SIZE_M - 8) {
        ok = false;
        break;
      }
      pts.push([nx, ny]);
    }
    if (!ok) continue;
    const cells = SIZE_M / RES;
    const grid = new GridSpace({ sizeX: cells, sizeY: cells, resolutionM: RES, chunkSize: 32 });
    for (let cj = 0; cj < grid.chunksY; cj++) for (let ci = 0; ci < grid.chunksX; ci++) grid.fillChunk("occupancy", ci, cj, OCCUPANCY_BLOCKED);
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const x = (i + 0.5) * RES;
        const y = (j + 0.5) * RES;
        for (let k = 0; k + 1 < pts.length; k++) {
          const [ax, ay] = pts[k] ?? [0, 0];
          const [bx, by] = pts[k + 1] ?? [0, 0];
          if (distToSegment(x, y, ax, ay, bx, by) <= width / 2) {
            grid.setCell("occupancy", i, j, OCCUPANCY_FREE);
            break;
          }
        }
      }
    }
    return { grid, start: pts[0] ?? [0, 0], startHeading, goal: pts[pts.length - 1] ?? [0, 0], sharpestTurn: sharpest };
  }
}

/** Distance from (x, y) to the nearest occupied cell square (out of map = occupied). */
export function obstacleClearance(g: GridSpace, x: number, y: number, maxM = 3): number {
  const res = g.resolutionM;
  const reach = Math.ceil(maxM / res);
  const ci = Math.floor(x / res);
  const cj = Math.floor(y / res);
  let best = maxM;
  for (let j = cj - reach; j <= cj + reach; j++) {
    for (let i = ci - reach; i <= ci + reach; i++) {
      if (!g.isBlocked(i, j)) continue;
      const dx = Math.max(i * res - x, 0, x - (i + 1) * res);
      const dy = Math.max(j * res - y, 0, y - (j + 1) * res);
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
    }
  }
  return best;
}

export interface TrackOutcome {
  readonly planned: boolean;
  readonly arrived: boolean;
  readonly stuck: boolean;
  /** Smallest distance from the vehicle's centre to an obstacle. */
  readonly minClearanceM: number;
  /** Largest distance from the vehicle's centre to the planned path (unsigned cross-track error). */
  readonly maxCrossTrackM: number;
  /**
   * Largest loss of clearance relative to the path: clearance at the nearest path point minus the
   * vehicle's clearance. This is the part of the cross-track error that moves towards obstacles.
   */
  readonly maxInwardM: number;
}

/** Plans with footprint + margin inflation, then tracks with pure pursuit; measures tracking errors. */
export function planAndTrack(c: Corridor, body: PursuitParams & { readonly footprintRadiusM: number; readonly trackingMarginM: number; readonly maxSpeedMps: number }): TrackOutcome {
  const profile = compileCostProfile({ weights: { distance: 1 } });
  if (!profile.ok) throw new Error("profile");
  const g = c.grid;
  const space = new SearchSpace(
    g,
    { vehicle: "ugv", cruiseAltitudeM: 0, clearanceM: 0, speedMps: body.maxSpeedMps, energyWhPerM: 0, inflationRadiusM: body.footprintRadiusM + body.trackingMarginM },
    profile.value,
  );
  const cell = ([x, y]: readonly [number, number]) => Math.floor(y / g.resolutionM) * g.sizeX + Math.floor(x / g.resolutionM);
  const q = new GridSearch(space, cell(c.start), cell(c.goal), { kind: "astar" }, 5_000_000);
  q.runToCompletion();
  if (q.status !== "found") return { planned: false, arrived: false, stuck: false, minClearanceM: Infinity, maxCrossTrackM: 0, maxInwardM: 0 };
  const wps = smoothPath(space, q.path());
  const flat = [c.start[0], c.start[1], ...wps.slice(1).flat()];
  const pp = new PurePursuit(Float64Array.from(flat), body, 30);
  // The vehicle starts aligned with the path: turning around at the start is a separate case (goTo's
  // kinematic feasibility check), not path tracking.
  const heading = detmath.atan2((flat[3] ?? c.start[1]) - c.start[1], (flat[2] ?? c.start[0]) - c.start[0]);
  const s: UgvState = { x: c.start[0], y: c.start[1], heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 };
  let minClear = Infinity;
  let maxXte = 0;
  let maxInward = 0;
  const dt = 0.1;
  for (let t = 0; t < 400; t += dt) {
    const cmd = pp.update(s, dt);
    if (cmd.arrived || cmd.stuck) return { planned: true, arrived: cmd.arrived, stuck: cmd.stuck, minClearanceM: minClear, maxCrossTrackM: maxXte, maxInwardM: maxInward };
    stepUgv(s, body, cmd.speed, cmd.curvature, dt);
    // Nearest point on the path polyline.
    let best = Infinity;
    let bx = s.x;
    let by = s.y;
    for (let k = 0; k + 3 < flat.length; k += 2) {
      const ax = flat[k] ?? 0;
      const ay = flat[k + 1] ?? 0;
      const ex = (flat[k + 2] ?? 0) - ax;
      const ey = (flat[k + 3] ?? 0) - ay;
      const len2 = ex * ex + ey * ey;
      const tt = len2 > 0 ? Math.min(1, Math.max(0, ((s.x - ax) * ex + (s.y - ay) * ey) / len2)) : 0;
      const qx = ax + tt * ex;
      const qy = ay + tt * ey;
      const d = Math.sqrt((qx - s.x) * (qx - s.x) + (qy - s.y) * (qy - s.y));
      if (d < best) {
        best = d;
        bx = qx;
        by = qy;
      }
    }
    const clear = obstacleClearance(g, s.x, s.y);
    minClear = Math.min(minClear, clear);
    maxXte = Math.max(maxXte, best);
    maxInward = Math.max(maxInward, obstacleClearance(g, bx, by) - clear);
  }
  return { planned: true, arrived: false, stuck: false, minClearanceM: minClear, maxCrossTrackM: maxXte, maxInwardM: maxInward };
}

export interface RuntimeOutcome {
  /** succeeded, or the failure code. */
  readonly outcome: string;
  /** True if the vehicle had not moved when the action ended (rejected up front). */
  readonly rejectedBeforeMoving: boolean;
  /** True if every move was a reverse during a traced back-off recovery (ADR-0033 §4). */
  readonly movedOnlyBackingOff: boolean;
  /** Back-off recoveries executed. */
  readonly recoveries: number;
  /** Smallest ground-truth clearance of the vehicle's centre while driving. */
  readonly minClearanceM: number;
  /** Reflex triggers while driving (planned paths should never need one). */
  readonly reflexes: number;
}

/**
 * Drives a corridor through the real action runtime and adapters (planner with footprint + margin
 * inflation, pre-drive check on the plan's map, pure pursuit, ground-truth contact), starting along the
 * corridor's first segment.
 */
export function driveWithRuntime(c: Corridor, body: ResolvedUgvBody): RuntimeOutcome {
  const g = c.grid;
  const spatial = new GridSpatialAdapter(g);
  const cfg: EffectiveAgentConfig = {
    agentId: "ugv-001",
    kind: "ugv",
    planning: { algorithm: "astar", onboardComputeExpansionsPerTick: 1_000_000, totalBudget: 10_000_000, costProfile: { weights: { distance: 1 } }, radiusM: 40, windowMarginM: 10 },
    planningSources: { algorithm: "builtin", onboardComputeExpansionsPerTick: "builtin", totalBudget: "builtin", costProfile: "builtin", radiusM: "builtin", windowMarginM: "builtin" },
    body,
    // The corridor tests check tracking on the true map: an ideal agent (ADR-0028 addition of 2026-10-09).
    beliefs: { init: "ideal", idealized: true },
    beliefsSource: "default",
    topology: DEFAULT_TOPOLOGY,
  };
  const planner = new PlanningServiceAdapter(new PlanningService(g), [cfg], spatial);
  let reflexes = 0;
  let recoveries = 0;
  const trace: TraceSink = {
    emit: (r) => {
      if (r.kind === "reflex") reflexes++;
      const p = r.payload as { op?: unknown; ok?: unknown } | null;
      if (p?.op === "recovery" && p.ok !== false) recoveries++;
      return "corridor";
    },
  };
  const dt = 0.1;
  const rt = new ActionRuntime({ planner, spatial, capabilities: toolsSchemaCapabilities, trace, reflexes: defaultReflexes() }, dt);
  const agent: SimAgent = {
    id: "ugv-001",
    kind: "ugv",
    body,
    battery: { soc: 1 },
    odometerM: 0,
    state: { x: c.start[0], y: c.start[1], heading: c.startHeading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 },
  };
  const started = rt.start(agent, "goTo", { xM: c.goal[0], yM: c.goal[1] }, { scope: "self", id: agent.id }, 0, 0);
  if (!started.ok) return { outcome: started.error.code, rejectedBeforeMoving: true, movedOnlyBackingOff: true, recoveries: 0, minClearanceM: Infinity, reflexes: 0 };
  let minClear = Infinity;
  let moved = false;
  let movedOtherwise = false;
  for (let t = 0; t < 20_000; t++) {
    planner.advance(t);
    rt.tick(agent, t, t * dt);
    // Movement during a checked recovery (a back-off reverse, or an escape from the planning band: ADR-0033) does not count.
    const recovering = rt.info(agent.id)?.phase === "backing-off";
    if (!recovering && (agent.state.lastRotationRad !== 0 || (agent.state.lastStepM > 0 && agent.state.speed >= 0))) movedOtherwise = true;
    if (agent.state.lastStepM > 0 || agent.state.lastRotationRad !== 0) {
      moved = true;
      minClear = Math.min(minClear, obstacleClearance(g, agent.state.x, agent.state.y));
    }
    if (!rt.isRunning(agent.id)) break;
  }
  const info = rt.info(agent.id);
  return { outcome: info?.status === "succeeded" ? "succeeded" : (info?.failure?.code ?? "timeout"), rejectedBeforeMoving: !moved, movedOnlyBackingOff: recoveries > 0 && !movedOtherwise, recoveries, minClearanceM: minClear, reflexes };
}

export const CORRIDOR_BANDS: readonly (readonly [number, number])[] = [
  [1.6, 2.2],
  [2.2, 3.0],
  [3.0, 3.8],
  [3.8, 4.5],
  [4.5, 7.0],
];

/**
 * Property over one width band for one drive model (ADR-0033): 200 seeded corridors down to the narrowest
 * width the clearance mask allows (~2 × (footprint + margin)), driven through the real runtime. Every
 * case arrives without contact or is rejected before moving (kinematically_infeasible, unreachable or
 * target_blocked), and no reflex ever fires on a planned path. Counts per band are in CHANGELOG.md.
 * Returns the outcome counts.
 */
export function corridorBandOutcomes(body: ResolvedUgvBody, band: readonly [number, number], cases = 200): { outcomes: RuntimeOutcome[]; succeeded: number } {
  const outcomes = Array.from({ length: cases }, (_, k) => driveWithRuntime(generateCorridor(Rng.fromSeed(2026).derive(`band/${band[0]}/${k}`), band), body));
  return { outcomes, succeeded: outcomes.filter((o) => o.outcome === "succeeded").length };
}
