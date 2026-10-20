import { cos, sin } from "../../numerics/detmath/index.ts";
import { err, ok, type CodedError, type Result } from "../../result.ts";
import type { SimAgent, UgvBodyParams } from "../agent.ts";
import type { CapabilityPort, ContactPort, FrontierCandidate, FrontierPort, KnownSpace, PlanLeg, PlanMap, PlannerPort, PlanProgress, PlanQuery, PlanResult, ProximityPort, Scope, SpatialPort, TraceSink } from "../ports.ts";

/** Axis-aligned obstacle; `topM` = height for aerial vehicles (Infinity = unlimited). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  topM: number;
}

/** Rectangle world for runtime tests (100 × 100 m by default, ground at 0 m). */
export class FakeSpatial implements SpatialPort {
  version = 0;
  readonly altitudeLimitsM = { min: 0, max: 60 };
  readonly rects: Rect[] = [];

  constructor(readonly sizeM = 100) {}

  add(r: Partial<Rect> & { x0: number; y0: number; x1: number; y1: number }): void {
    this.rects.push({ topM: Number.POSITIVE_INFINITY, ...r });
    this.version++;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.sizeM && y < this.sizeM;
  }

  private inRect(x: number, y: number): Rect | undefined {
    return this.rects.find((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  }

  /** Optional geofence (stay inside) and no-fly volumes. */
  fence: { x0: number; y0: number; x1: number; y1: number } | undefined;
  readonly noFly: { x0: number; y0: number; x1: number; y1: number; minZ: number; maxZ: number }[] = [];

  insideFence(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const f = this.fence;
    if (f && !(x >= f.x0 && x < f.x1 && y >= f.y0 && y < f.y1)) return false;
    return !this.noFly.some((n) => x >= n.x0 && x < n.x1 && y >= n.y0 && y < n.y1 && z >= n.minZ && z <= n.maxZ);
  }

  freeForGround(x: number, y: number): boolean {
    return this.insideFence(x, y, 0) && !this.inRect(x, y);
  }

  freeForAir(x: number, y: number, z: number, clearanceM: number): boolean {
    if (!this.insideFence(x, y, z) || z < this.altitudeLimitsM.min || z > this.altitudeLimitsM.max) return false;
    const r = this.inRect(x, y);
    return !r || z >= r.topM + clearanceM;
  }

  groundHeightM(): number {
    return 0;
  }

  landable(x: number, y: number): boolean {
    return this.freeForGround(x, y);
  }

  groundClearanceM(x: number, y: number, maxM: number): number {
    let d = Math.min(maxM, x, y, this.sizeM - x, this.sizeM - y);
    for (const r of this.rects) {
      const dx = Math.max(r.x0 - x, 0, x - r.x1);
      const dy = Math.max(r.y0 - y, 0, y - r.y1);
      d = Math.min(d, Math.sqrt(dx * dx + dy * dy));
    }
    return Math.max(0, d);
  }

  /** Contact with rects (1 m cells): for each touched rect, the cell of its point nearest to (x, y). */
  contactCells(x: number, y: number, z: number, radiusM: number, vehicle: "uav" | "ugv"): readonly number[] {
    const out: number[] = [];
    for (const r of this.rects) {
      if (vehicle === "uav" && r.topM < z) continue;
      const nx = Math.min(Math.max(x, r.x0), r.x1);
      const ny = Math.min(Math.max(y, r.y0), r.y1);
      if ((nx - x) * (nx - x) + (ny - y) * (ny - y) < radiusM * radiusM) out.push(Math.floor(Math.min(nx, r.x1 - 1e-9)), Math.floor(Math.min(ny, r.y1 - 1e-9)));
    }
    return out;
  }
}

/**
 * Proximity fake (F2): a perfect proximity sensor on the fake world. For each tracked agent, 72 rays (5°) march
 * in 0.05 m steps up to `rangeM` from its current pose; each ray's first point inside a rect (for a UAV, one
 * reaching its altitude) is a hit. Computed on demand, so the reading is always current.
 */
export class FakeProximity implements ProximityPort {
  private readonly agents = new Map<string, SimAgent>();
  /** Per agent: no reading at all (a dropout). */
  readonly dropped = new Set<string>();

  constructor(
    private readonly spatial: FakeSpatial,
    private readonly rangeM = 2,
  ) {}

  track(a: SimAgent): void {
    this.agents.set(a.id, a);
  }

  hits(agentId: string): readonly number[] {
    const a = this.agents.get(agentId);
    if (!a || this.dropped.has(agentId)) return [];
    const z = a.kind === "uav" ? a.state.z : 0;
    const out: number[] = [];
    for (let k = 0; k < 72; k++) {
      const ang = (k * Math.PI) / 36;
      const ux = cos(ang);
      const uy = sin(ang);
      for (let d = 0.05; d <= this.rangeM + 1e-9; d += 0.05) {
        const px = a.state.x + ux * d;
        const py = a.state.y + uy * d;
        const r = this.spatial.rects.find((q) => px >= q.x0 && px < q.x1 && py >= q.y0 && py < q.y1);
        if (r && (a.kind === "ugv" || r.topM >= z)) {
          out.push(px, py);
          break;
        }
      }
    }
    return out;
  }
}

/** Records contact observations (F2 bump). */
export class FakeContact implements ContactPort {
  readonly contacts: { agentId: string; cells: readonly number[]; lowerM: number }[] = [];
  contact(agentId: string, cells: readonly number[], lowerM: number): void {
    this.contacts.push({ agentId, cells: [...cells], lowerM });
  }
}

/**
 * Planner fake: a path along `route(query)` (default: straight line), completed `delayTicks` advances
 * after submission, or a scripted status.
 */
export class FakePlanner implements PlannerPort {
  /** The agent's map (belief). Tests make it differ from ground truth to check what decisions use. */
  constructor(public belief: FakeSpatial = new FakeSpatial()) {}

  readonly submissions: { agentId: string; q: PlanQuery; tick: number }[] = [];
  delayTicks = 2;
  status: PlanResult["status"] = "found";
  /** What a query ends with, by its content (its window, its target); absent: `status`. */
  answer: ((q: PlanQuery) => PlanResult["status"]) | undefined;
  route: (q: PlanQuery) => [number, number][] = (q) => [
    [q.from.x, q.from.y],
    [q.to.x, q.to.y],
  ];
  /**
   * A lazy plan (F2b M3): the legs a query yields (each leg's waypoints, the first being the previous leg's last), and the
   * tick, counted from the first advance after the submission, at which each becomes ready. `failAtLeg` ends the query
   * with that status when its leg would have come.
   */
  lazy: { legs: (q: PlanQuery) => [number, number][][]; ready: number[]; failAtLeg?: { index: number; status: "not_found" | "budget_exceeded" } } | undefined;
  /** Agents whose pending query was cancelled (stop, preemption, replan). */
  readonly cancelled: string[] = [];
  private lazyQueries = new Map<
    string,
    { id: string; legs: [number, number][][]; ready: number[]; fail: { index: number; status: "not_found" | "budget_exceeded" } | undefined; age: number; produced: number; taken: number; producedAt: number[]; done: boolean; status: PlanResult["status"] | undefined }
  >();
  private interrupts = new Set<string>();
  private pending = new Map<string, { id: string; q: PlanQuery; left: number }>();
  private done = new Map<string, PlanResult>();
  private next = 1;
  private tickNow = 0;

  /** The next `takeLegs` of this agent reports that the planner ended its lazy query because the map changed. */
  interruptNext(agentId: string): void {
    this.interrupts.add(agentId);
  }

  advance(tick: number): void {
    this.tickNow = tick;
    for (const [, l] of [...this.lazyQueries].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (l.done) continue;
      l.age++;
      while (!l.done && l.produced < l.legs.length && (l.ready[l.produced] ?? Number.POSITIVE_INFINITY) <= l.age) {
        if (l.fail?.index === l.produced) {
          l.done = true;
          l.status = l.fail.status;
          break;
        }
        l.producedAt.push(tick);
        l.produced++;
      }
      if (!l.done && l.produced === l.legs.length) {
        l.done = true;
        l.status = "found";
      }
    }
    for (const [agentId, p] of [...this.pending].sort(([a], [b]) => (a < b ? -1 : 1))) {
      p.left--;
      if (p.left > 0) continue;
      this.pending.delete(agentId);
      const status = this.answer ? this.answer(p.q) : this.status;
      const found = status === "found";
      this.done.set(p.id, { status, waypoints: found ? this.route(p.q) : [], expansionsCharged: 1000, completedTick: tick, map: this.currentMap() });
    }
  }

  submit(agentId: string, q: PlanQuery, tick: number): Result<string, CodedError> {
    const id = `plan-${this.next++}`;
    this.submissions.push({ agentId, q, tick });
    if (this.lazy) {
      this.lazyQueries.set(agentId, { id, legs: this.lazy.legs(q), ready: this.lazy.ready, fail: this.lazy.failAtLeg, age: 0, produced: 0, taken: 0, producedAt: [], done: false, status: undefined });
      return ok(id);
    }
    this.pending.set(agentId, { id, q, left: this.delayTicks });
    return ok(id);
  }

  take(_agentId: string, queryId: string): PlanResult | undefined {
    const r = this.done.get(queryId);
    if (r) this.done.delete(queryId);
    return r;
  }

  takeLegs(agentId: string, queryId: string): PlanProgress | undefined {
    const l = this.lazyQueries.get(agentId);
    if (!l || l.id !== queryId) return undefined;
    if (this.interrupts.delete(agentId)) {
      this.lazyQueries.delete(agentId);
      return { legs: [], done: true, interrupted: "map_changed", map: this.currentMap(), expansionsCharged: 1000, completedTick: this.tickNow };
    }
    const legs: PlanLeg[] = [];
    for (let k = l.taken; k < l.produced; k++) legs.push({ index: k, count: l.legs.length, last: k === l.legs.length - 1, waypoints: l.legs[k] ?? [], tick: l.producedAt[k] ?? this.tickNow });
    l.taken = l.produced;
    if (legs.length === 0 && !l.done) return undefined;
    if (l.done) this.lazyQueries.delete(agentId);
    return { legs, done: l.done, ...(l.status ? { status: l.status } : {}), map: this.currentMap(), expansionsCharged: 1000, completedTick: this.tickNow };
  }

  cancel(agentId: string): void {
    if (this.pending.delete(agentId) || this.lazyQueries.delete(agentId)) this.cancelled.push(agentId);
  }

  /** The agent's exploration scope (ADR-0040); a test changes it to try other radii. */
  explore = { radiusM: 40, windowMarginM: 10 };
  exploreParams(): { readonly radiusM: number; readonly windowMarginM: number } {
    return this.explore;
  }

  /** The planning view's extra blocked area (the inflated band): a test sets it; the belief's rectangles block as ever. */
  viewBlocked: (x: number, y: number) => boolean = () => false;

  currentMap(): PlanMap {
    const b = this.belief;
    return {
      version: b.version,
      clearanceM: (x, y, maxM) => b.groundClearanceM(x, y, maxM),
      passableAt: (x, y) => b.inBounds(x, y) && b.freeForGround(x, y) && !this.viewBlocked(x, y),
    };
  }

  /** Start-time checks on the agent's map (the fake belief), never the runtime's ground truth. */
  knownSpace(): KnownSpace {
    const b = this.belief;
    return {
      freeForGround: (x, y) => b.freeForGround(x, y),
      freeForAir: (x, y, z, c) => b.freeForAir(x, y, z, c),
      landable: (x, y) => b.landable(x, y),
    };
  }

  get now(): number {
    return this.tickNow;
  }
}

interface CapDef {
  readonly kind?: "bookkeeping";
  readonly vehicles: readonly string[];
  readonly preconditions: readonly { readonly name: string; readonly vehicles?: readonly string[] }[];
  readonly check: (p: Record<string, unknown>) => boolean;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const CAPS: Record<string, CapDef> = {
  goTo: { vehicles: ["uav", "ugv"], preconditions: [{ name: "airborne", vehicles: ["uav"] }], check: (p) => num(p["xM"]) && num(p["yM"]) && (p["altitudeM"] === undefined || num(p["altitudeM"])) },
  hold: { vehicles: ["uav", "ugv"], preconditions: [], check: (p) => p["durationS"] === undefined || (num(p["durationS"]) && (p["durationS"] as number) > 0) },
  returnToBase: { vehicles: ["uav", "ugv"], preconditions: [{ name: "hasBase" }], check: () => true },
  takeoff: { vehicles: ["uav"], preconditions: [{ name: "grounded" }], check: (p) => num(p["altitudeM"]) && (p["altitudeM"] as number) > 0 },
  land: { vehicles: ["uav"], preconditions: [{ name: "airborne" }], check: () => true },
  setTimer: { kind: "bookkeeping", vehicles: ["uav", "ugv"], preconditions: [], check: (p) => num(p["delayS"]) && typeof p["tag"] === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(p["tag"] as string) },
  cancelTimer: { kind: "bookkeeping", vehicles: ["uav", "ugv"], preconditions: [], check: (p) => typeof p["tag"] === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(p["tag"] as string) },
  explore: {
    vehicles: ["uav", "ugv"],
    preconditions: [{ name: "airborne", vehicles: ["uav"] }, { name: "hasRangeSensor" }],
    check: (p) => (p["region"] === undefined || typeof p["region"] === "string") && (p["strategy"] === undefined || p["strategy"] === "nearest" || p["strategy"] === "largest") && (p["radiusM"] === undefined || (num(p["radiusM"]) && (p["radiusM"] as number) > 0)),
  },
};

/**
 * Scripted frontier layer for explore tests: groups given as (id, region, point x/y, size). A group is resolved
 * (no longer a frontier, no longer a candidate) once the tracked agent comes within 1 m of its point. Marks hide a
 * group unless `marksStick` is false (as if the view changed around it at once).
 */
export class FakeFrontiers implements FrontierPort {
  readonly groups: { id: string; region: string; xM: number; yM: number; size: number; resolved: boolean }[] = [];
  readonly marked = new Set<string>();
  readonly temporary = new Set<string>();
  readonly markCalls: string[] = [];
  readonly temporaryCalls: string[] = [];
  clearCalls = 0;
  marksStick = true;
  regions = new Map<string, { x0: number; y0: number; x1: number; y1: number; reachableUnknown: boolean }>();
  constructor(private readonly agent: SimAgent) {}

  add(id: string, region: string, xM: number, yM: number, size = 5): void {
    this.groups.push({ id, region, xM, yM, size, resolved: false });
  }

  private refresh(): void {
    for (const g of this.groups) {
      const dx = g.xM - this.agent.state.x;
      const dy = g.yM - this.agent.state.y;
      if (dx * dx + dy * dy < 1) g.resolved = true;
    }
  }

  /** The cell of a group's point (100 cells a row, 1 m cells); its other cells follow along the row. */
  private cellOf(g: { xM: number; yM: number }): number {
    return Math.floor(g.yM) * 100 + Math.floor(g.xM);
  }

  hasRegion(_agentId: string, region: string): boolean {
    return this.regions.has(region);
  }

  regionRect(_agentId: string, region: string) {
    return this.regions.get(region);
  }

  candidates(): FrontierCandidate[] {
    this.refresh();
    return this.groups
      .filter((g) => !g.resolved && !this.marked.has(g.id))
      .map((g) => ({
        id: g.id,
        region: g.region,
        cells: Array.from({ length: g.size }, (_, k) => this.cellOf(g) + k),
        point: this.cellOf(g),
        xM: g.xM,
        yM: g.yM,
        temporary: this.temporary.has(g.id),
      }));
  }

  cellCentre(_agentId: string, cell: number): { xM: number; yM: number } {
    return { xM: (cell % 100) + 0.5, yM: Math.floor(cell / 100) + 0.5 };
  }

  markedCount(): number {
    return this.marked.size;
  }

  isFrontier(_agentId: string, cell: number): boolean {
    this.refresh();
    return this.groups.some((g) => !g.resolved && this.cellOf(g) === cell);
  }

  /** The fake agent has a range sensor unless a test says otherwise. */
  rangeSensor = true;
  hasRangeSensor(): boolean {
    return this.rangeSensor;
  }

  /** The fake agent knows its surroundings unless a test says otherwise. */
  knowsOwnCell = true;
  isKnown(): boolean {
    return this.knowsOwnCell;
  }

  regionHasReachableUnknown(_agentId: string, region: string): boolean {
    return this.regions.get(region)?.reachableUnknown ?? false;
  }

  private groupAt(xM: number, yM: number) {
    return this.groups.find((x) => !x.resolved && Math.abs(x.xM - xM) < 1e-9 && Math.abs(x.yM - yM) < 1e-9);
  }

  markAt(_agentId: string, xM: number, yM: number): boolean {
    const g = this.groupAt(xM, yM);
    if (!g) return false;
    this.markCalls.push(g.id);
    this.temporary.delete(g.id);
    if (this.marksStick) this.marked.add(g.id);
    return true;
  }

  markTemporaryAt(_agentId: string, xM: number, yM: number): boolean {
    const g = this.groupAt(xM, yM);
    if (!g) return false;
    this.temporaryCalls.push(g.id);
    this.temporary.add(g.id);
    return true;
  }

  clearTemporary(): void {
    this.clearCalls++;
    this.temporary.clear();
  }
}

/** Minimal stand-in for tools-schema (the real one is wired and tested in @agentsim/scenarios/assemble). */
export const fakeCapabilities: CapabilityPort = {
  list: () => Object.keys(CAPS).map((name) => ({ name, kind: CAPS[name]?.kind ?? "action", paramsSchema: { type: "object" } })),
  kind: (name) => CAPS[name]?.kind ?? "action",
  injectable: (name) => ["explore", "goTo", "hold", "land", "takeoff"].includes(name),
  validate(name, params) {
    const c = Object.hasOwn(CAPS, name) ? CAPS[name] : undefined;
    if (!c) return err({ code: "unknown_capability", message: name });
    if (typeof params !== "object" || params === null || !c.check(params as Record<string, unknown>)) return err({ code: "invalid_params", message: "bad params" });
    return ok(params);
  },
  vehicles: (name) => CAPS[name]?.vehicles ?? [],
  scope: (): Scope => "self",
  preconditions: (name) => CAPS[name]?.preconditions ?? [],
};

export class CollectingTrace implements TraceSink {
  readonly records: Parameters<TraceSink["emit"]>[0][] = [];
  emit(r: Parameters<TraceSink["emit"]>[0]): void {
    this.records.push(r);
  }
  ops(op: string): unknown[] {
    return this.records.map((r) => r.payload as { op: string }).filter((p) => p.op === op);
  }
}

const battery = { capacityWh: 500, criticalSoc: 0.15 };

export function makeUgv(x = 10, y = 10, heading = 0, over: Partial<UgvBodyParams> = {}): SimAgent {
  return {
    id: "ugv-001",
    kind: "ugv",
    body: {
      drive: "forward-only",
      reverseAllowed: false,
      maxReverseSpeedMps: 0.5,
      maxYawRateRadps: 1.5,
      wheelbaseM: 1,
      maxSteeringAngleRad: 0.6,
      maxSteeringRateRadps: 1,
      maxSpeedMps: 2,
      turningRadiusM: 1.5,
      lookaheadM: 1.2,
      arrivalToleranceM: 0.5,
      footprintRadiusM: 0.5,
      trackingMarginM: 0.25,
      battery,
      energy: { movingWhPerM: 0.05, idleW: 10 },
      ...over,
    },
    state: { x, y, heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 },
    battery: { soc: 1 },
    odometerM: 0,
    base: { xM: 5, yM: 5 },
  };
}

export function makeUav(x = 10, y = 10, z = 0, airborne = false): SimAgent {
  return {
    id: "uav-001",
    kind: "uav",
    body: { maxSpeedMps: 8, climbRateMps: 2, cruiseAltitudeM: 20, clearanceM: 2, footprintRadiusM: 0.4, battery: { capacityWh: 100, criticalSoc: 0.2 }, energy: { movingWhPerM: 0.02, idleW: 150 } },
    state: { x, y, z, heading: 0, airborne, lastStepM: 0 },
    battery: { soc: 1 },
    odometerM: 0,
    base: { xM: 5, yM: 5 },
  };
}
