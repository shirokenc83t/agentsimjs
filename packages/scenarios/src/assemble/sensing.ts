import { detmath, Rng, StateHasher, type AgentEvent, type ContactPort, type ProximityPort, type SimAgent, type TraceSink } from "@agentsim/core";
import {
  BeliefMap,
  cameraSees,
  newCameraScratch,
  newRangeScratch,
  periodUs,
  readsAtTick,
  senseRay,
  sensorPhaseUs,
  type BeliefMapSnapshot,
  type GridSpace,
  type RangeRay,
  type RangeScratch,
  type RangeSink,
} from "@agentsim/spatial";
import type { ResolvedCamera, ResolvedRangeSensor, ResolvedSensor, ResolvedUavBody, ResolvedUgvBody } from "../body-defaults.ts";
import type { LoadedObject } from "../load.ts";

/** What an agent believes about an entity it has seen (ADR-0012 addition: camera detections). */
export interface EntityBelief {
  readonly xM: number;
  readonly yM: number;
  readonly zM: number;
  readonly observedAtS: number;
  /** What the entity is (a scenario object's kind, or `uav` / `ugv`): F2 cameras classify perfectly (ADR-0005 addition). */
  readonly kind: string;
  /** Not observed for `lostAfterS`: a `lost` event was raised. Derived from time, so it is not hashed. */
  readonly lost: boolean;
}

/** The state of a `SensingService` between ticks, as plain data (see `SensingService.snapshot`). */
export interface SensingSnapshot {
  /** Tick of the latest sensing phase: read only by the observation-only ray recorder, kept for completeness. */
  readonly curTick: number;
  readonly agents: readonly {
    readonly agentId: string;
    readonly belief: BeliefMapSnapshot;
    /** Entity beliefs in insertion order. */
    readonly entities: readonly (readonly [string, EntityBelief])[];
    /** Latest proximity hit points, flat (x, y). */
    readonly proximity: readonly number[];
    /** Each sensor by ID order, with the state of its noise stream. */
    readonly sensors: readonly { readonly id: string; readonly rng: { readonly s: readonly [number, number, number, number]; readonly spareNormal: number }; readonly dropped: boolean }[];
  }[];
}

/** Rays kept per lidar reading by the overlay recorder (decimated by a fixed stride) and lidars recorded per agent. */
const RAYS_PER_SENSOR = 64;
const MAX_RANGE_SENSORS = 2;

interface RayRecorder {
  readonly agentId: string;
  /** Tick of the readings in `segs`, and how many rays they hold (x0, y0, x1, y1 each). */
  tick: number;
  n: number;
  readonly segs: Float32Array;
  readonly hit: Uint8Array;
  /** Tick last handed out by `takeRays`. */
  seenTick: number;
}

interface SensorState {
  readonly spec: ResolvedSensor;
  readonly periodUs: number;
  readonly phaseUs: number;
  readonly rng: Rng;
  readonly scratch: RangeScratch | undefined;
  readonly window: ReadingWindow | undefined;
  /** One ray object reused for every ray of the sensor (no allocation per ray). */
  readonly ray: MutableRay | undefined;
  /** Range noise, drawn only for rays that hit (none when the sensor has no noise). */
  readonly noise: { draw(): number } | undefined;
  /** Range sensors: each ray's direction relative to the heading (cos, sin), computed once with detmath. */
  readonly rayCos: Float64Array | undefined;
  readonly raySin: Float64Array | undefined;
  /** In a dropout streak (traced at its start and end). */
  dropped: boolean;
}

/**
 * Range-noise margin of the inverse sensor model (ADR-0012 clarification of 2026-10-10): two standard deviations
 * of the sensor's range noise, and at least one cell; 0 without noise.
 */
export function rangeMarginM(rangeSigmaM: number, resolutionM: number): number {
  // Hit localization at cell resolution needs noise small relative to a cell (checkSensorNoise rejects the rest).
  if (rangeSigmaM > resolutionM / 4 + 1e-12) throw new Error(`range noise σ ${rangeSigmaM} m above a quarter cell (${resolutionM} m): run checkSensorNoise first`);
  return rangeSigmaM > 0 ? Math.max(2 * rangeSigmaM, resolutionM) : 0;
}

const FREE = 1;
const UNDER = 2;
const HIT = 3;

type MutableRay = { -readonly [K in keyof RangeRay]: RangeRay[K] };

/**
 * The cells one reading touched, each with its strongest outcome (hit > under > free), in first-touch order
 * (ADR-0012 clarification: a reading updates each cell at most once). A reading only reaches cells within its
 * range of the sensor, so a dense square window around the sensor's cell, with a reading stamp per cell, replaces
 * any hashing: one array read per touched cell. Allocation-free after construction. It is the ray walk's sink.
 */
class ReadingWindow implements RangeSink {
  private readonly side: number;
  private readonly half: number;
  private readonly stamp: Uint32Array;
  private readonly best: Uint8Array;
  /** Touched cells in first-touch order, as window indices. */
  private readonly order: Int32Array;
  private size = 0;
  private reading = 0;
  private i0 = 0;
  private j0 = 0;

  constructor(rangeM: number, resolutionM: number) {
    this.half = Math.ceil(rangeM / resolutionM) + 2;
    this.side = 2 * this.half + 1;
    const n = this.side * this.side;
    this.stamp = new Uint32Array(n);
    this.best = new Uint8Array(n);
    this.order = new Int32Array(n);
  }

  /** Starts a reading from the sensor's cell. */
  begin(ci: number, cj: number): void {
    this.reading++;
    this.size = 0;
    this.i0 = ci - this.half;
    this.j0 = cj - this.half;
  }

  private add(i: number, j: number, outcome: number): void {
    const w = (j - this.j0) * this.side + (i - this.i0);
    if (this.stamp[w] !== this.reading) {
      this.stamp[w] = this.reading;
      this.best[w] = outcome;
      this.order[this.size++] = w;
    } else if (outcome > (this.best[w] ?? 0)) this.best[w] = outcome;
  }

  free(i: number, j: number): void {
    this.add(i, j, FREE);
  }

  under(i: number, j: number): void {
    this.add(i, j, UNDER);
  }

  hit(i: number, j: number): void {
    this.add(i, j, HIT);
  }

  /** Applies the reading to the belief map: once per cell, in first-touch order. */
  apply(belief: BeliefMap, beamLowerM: number, hitInc: number, missInc: number): void {
    const side = this.side;
    for (let n = 0; n < this.size; n++) {
      const w = this.order[n] ?? 0;
      const wj = (w / side) | 0;
      const i = this.i0 + (w - wj * side);
      const j = this.j0 + wj;
      const o = this.best[w];
      if (o === HIT) belief.observeHit(i, j, beamLowerM, hitInc);
      else if (o === UNDER) belief.observeUnder(i, j, beamLowerM, hitInc);
      else belief.observeFree(i, j, missInc);
    }
  }
}

interface AgentSensing {
  readonly agent: SimAgent;
  readonly sensors: readonly SensorState[];
  readonly belief: BeliefMap;
  readonly entities: Map<string, EntityBelief>;
  /** Latest proximity hit points (flat x, y). */
  proximity: number[];
}

/**
 * The sensing phase of a run (F2 M2a; ADR-0012 addition of 2026-10-09). After the actions of each tick, every
 * due sensor of every agent observes the ground truth, in a fixed order (agents in ID order, sensors in ID order,
 * rays in index order), and what it reports goes into that agent's beliefs only:
 * - range sensors (lidar, proximity) update its belief map; proximity hits also feed the obstacle reflex;
 * - cameras update its entity beliefs (scenario objects and other agents).
 * Noise and dropouts draw from the run's `Rng` sub-streams `agent/<id>/sensor/<sensorId>`. Contact observations
 * (a bump) come from collisions. Minds never read any of this directly: it reaches them only as beliefs.
 */
export class SensingService implements ProximityPort, ContactPort {
  private readonly byId = new Map<string, AgentSensing>();
  private readonly order: AgentSensing[] = [];
  private readonly cameraScratch = newCameraScratch();
  private readonly tickUs: number;
  /** Perception events of the tick just sensed (`detected`, `lost`), taken by the world once per tick. */
  private pending: AgentEvent[] = [];
  private rayRec: RayRecorder | undefined;
  private curTick = 0;

  constructor(
    private readonly grid: GridSpace,
    agents: readonly SimAgent[],
    private readonly objects: readonly LoadedObject[],
    seed: number,
    dtS: number,
    private readonly trace: TraceSink,
    /** `ideal` agents (ADR-0028 addition): their map is ground truth, so range readings do not update it. */
    private readonly ideal: ReadonlySet<string> = new Set(),
  ) {
    this.tickUs = Math.round(dtS * 1_000_000);
    const root = Rng.fromSeed(seed);
    for (const agent of agents) {
      const body = agent.body as unknown as ResolvedUavBody | ResolvedUgvBody;
      const specs = [...(body.sensors ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const sensors = specs.map((spec): SensorState => {
        const p = periodUs(spec.rateHz);
        let rayCos: Float64Array | undefined;
        let raySin: Float64Array | undefined;
        if (spec.type !== "camera") {
          rayCos = new Float64Array(spec.rays);
          raySin = new Float64Array(spec.rays);
          const fov = (spec.fovDeg * Math.PI) / 180;
          const full = spec.fovDeg >= 360;
          for (let k = 0; k < spec.rays; k++) {
            const rel = full ? (k * 2 * Math.PI) / spec.rays : -fov / 2 + ((k + 0.5) * fov) / spec.rays;
            rayCos[k] = detmath.cos(rel);
            raySin[k] = detmath.sin(rel);
          }
        }
        const rng = root.derive(`agent/${agent.id}/sensor/${spec.id}`);
        return {
          rayCos,
          raySin,
          spec,
          periodUs: p,
          phaseUs: sensorPhaseUs(`${agent.key ?? agent.id}/${spec.id}`, p),
          rng,
          scratch: spec.type === "camera" ? undefined : newRangeScratch(spec.rangeM, grid.resolutionM),
          window: spec.type === "camera" ? undefined : new ReadingWindow(spec.rangeM, grid.resolutionM),
          noise: spec.type !== "camera" && spec.rangeSigmaM > 0 ? { draw: () => rng.normal(0, spec.rangeSigmaM) } : undefined,
          ray: spec.type === "camera" ? undefined : { x: 0, y: 0, zM: 0, beamLowerM: 0, dirX: 1, dirY: 0, rangeM: spec.rangeM, noiseM: 0, marginM: rangeMarginM(spec.rangeSigmaM, grid.resolutionM) },
          dropped: false,
        };
      });
      const s: AgentSensing = { agent, sensors, belief: new BeliefMap(grid.sizeX, grid.sizeY, grid.chunkSize), entities: new Map(), proximity: [] };
      this.byId.set(agent.id, s);
      this.order.push(s);
    }
  }

  /** Sensing phase of `tick`: every sensor whose schedule falls in this tick reads. */
  /**
   * Observation-only ray recorder (ADR-0012 addition of 2026-10-12): while an agent is watched, the rays of its range
   * sensors are recorded as segments for the Scene's overlay, decimated to at most `RAYS_PER_SENSOR` per reading. It reads
   * what each reading already computed (direction, distance, hit): no rng, no belief or hash input, nothing traced, and
   * nothing at all for any other agent or when nobody is watched (one comparison per reading).
   */
  watchRays(agentId: string | null): void {
    this.rayRec = agentId === null ? undefined : { agentId, tick: -1, n: 0, segs: new Float32Array(RAYS_PER_SENSOR * 4 * MAX_RANGE_SENSORS), hit: new Uint8Array(RAYS_PER_SENSOR * MAX_RANGE_SENSORS), seenTick: -2 };
  }

  /** The watched agent's rays of the latest sensing tick that has any, once (a copy), or undefined if nothing new. */
  takeRays(): { readonly tick: number; readonly segments: Float32Array; readonly hit: Uint8Array } | undefined {
    const r = this.rayRec;
    if (!r || r.n === 0 || r.tick === r.seenTick) return undefined;
    r.seenTick = r.tick;
    return { tick: r.tick, segments: r.segs.slice(0, r.n * 4), hit: r.hit.slice(0, r.n) };
  }

  sense(tick: number, simTimeS: number): void {
    this.curTick = tick;
    const nowUs = tick * this.tickUs;
    const prevUs = (tick - 1) * this.tickUs;
    for (const s of this.order) {
      for (const st of s.sensors) {
        if (!readsAtTick(nowUs, prevUs, st.periodUs, st.phaseUs)) continue;
        if (this.droppedOut(s, st, simTimeS)) continue;
        if (st.spec.type === "camera") this.readCamera(s, st, st.spec, simTimeS);
        else this.readRange(s, st, st.spec);
      }
      this.sweepLost(s, simTimeS);
    }
  }

  /** Perception events raised since the last call, in the order they happened (the inbox orders them for minds). */
  takeEvents(): AgentEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /**
   * An entity becomes `lost` only after it has not been observed for the body's `lostAfterS` (default 2 s), so one at
   * the edge of sensor range does not flap between `detected` and `lost` (ADR-0005 addition).
   */
  private sweepLost(s: AgentSensing, simTimeS: number): void {
    const lostAfterS = (s.agent.body as unknown as { beliefs?: { lostAfterS?: number } }).beliefs?.lostAfterS ?? 2;
    for (const [id, e] of s.entities) {
      if (e.lost || simTimeS - e.observedAtS <= lostAfterS + 1e-9) continue;
      s.entities.set(id, { ...e, lost: true });
      this.pending.push({ agentId: s.agent.id, event: { kind: "lost", entityId: id, entityKind: e.kind, lastSeenS: e.observedAtS, transitions: 1 } });
    }
  }

  private droppedOut(s: AgentSensing, st: SensorState, simTimeS: number): boolean {
    const p = st.spec.dropoutProbability;
    const lost = p > 0 && st.rng.nextFloat01() < p;
    if (lost !== st.dropped) {
      st.dropped = lost;
      this.trace.emit({ source: `${s.agent.id}/sensors`, simTime: simTimeS, kind: "event", agentId: s.agent.id, detail: "full", payload: { op: "dropout", sensor: st.spec.id, state: lost ? "start" : "end" } });
    }
    return lost;
  }

  private readRange(s: AgentSensing, st: SensorState, spec: ResolvedRangeSensor): void {
    const a = s.agent;
    // Lidar only: a proximity sensor's rays are a few metres long and would only clutter the overlay.
    const rec = this.rayRec !== undefined && this.rayRec.agentId === a.id && spec.type === "lidar" ? this.rayRec : undefined;
    if (rec && rec.tick !== this.curTick) {
      rec.tick = this.curTick;
      rec.n = 0;
    }
    const stride = Math.max(1, Math.ceil(spec.rays / RAYS_PER_SENSOR));
    const z = a.kind === "uav" ? a.state.z : spec.mountHeightM;
    const beamLowerM = Math.max(0, z - spec.beamHalfHeightM);
    const isProximity = spec.type === "proximity";
    if (isProximity) s.proximity = [];
    // Collect the reading first: each cell is updated once, with its strongest outcome (ADR-0012 clarification).
    const win = st.window as ReadingWindow;
    win.begin(this.grid.cellI(a.state.x), this.grid.cellJ(a.state.y));
    // Ray directions: the sensor's fixed offsets rotated by the heading (two detmath calls per reading).
    const ch = detmath.cos(a.state.heading);
    const sh = detmath.sin(a.state.heading);
    const rc = st.rayCos as Float64Array;
    const rs = st.raySin as Float64Array;
    const ray = st.ray as MutableRay;
    ray.x = a.state.x;
    ray.y = a.state.y;
    ray.zM = z;
    ray.beamLowerM = beamLowerM;
    ray.rangeM = spec.rangeM;
    for (let k = 0; k < spec.rays; k++) {
      const c = rc[k] ?? 1;
      const sn = rs[k] ?? 0;
      ray.dirX = ch * c - sh * sn;
      ray.dirY = sh * c + ch * sn;
      const d = senseRay(this.grid, ray, win, st.scratch as RangeScratch, st.noise);
      if (rec && k % stride === 0 && rec.n < RAYS_PER_SENSOR * MAX_RANGE_SENSORS) {
        const len = d >= 0 ? d : spec.rangeM;
        const o = rec.n * 4;
        rec.segs[o] = a.state.x;
        rec.segs[o + 1] = a.state.y;
        rec.segs[o + 2] = a.state.x + ray.dirX * len;
        rec.segs[o + 3] = a.state.y + ray.dirY * len;
        rec.hit[rec.n++] = d >= 0 ? 1 : 0;
      }
      if (isProximity && d >= 0) s.proximity.push(a.state.x + ray.dirX * d, a.state.y + ray.dirY * d);
    }
    // An ideal agent's map is the ground truth: its readings still feed proximity, never its map.
    if (!this.ideal.has(a.id)) win.apply(s.belief, beamLowerM, spec.logOddsHit, spec.logOddsMiss);
  }

  private readCamera(s: AgentSensing, st: SensorState, spec: ResolvedCamera, simTimeS: number): void {
    const a = s.agent;
    const view = {
      x: a.state.x,
      y: a.state.y,
      // ADR-0025 addition: a UGV camera's mount is above the ground, a UAV camera's above the vehicle.
      z: a.kind === "uav" ? a.state.z + spec.mountHeightM : spec.mountHeightM,
      headingRad: a.state.heading,
      fovRad: (spec.fovDeg * Math.PI) / 180,
      rangeM: spec.rangeM,
    };
    // Entities in ID order: scenario objects, then the other agents.
    const seen = (id: string, kind: string, x: number, y: number, z: number) => {
      if (!cameraSees(this.grid, view, { x, y, z }, this.cameraScratch)) return;
      if (spec.pDetect < 1 && st.rng.nextFloat01() >= spec.pDetect) return;
      const nx = spec.positionSigmaM > 0 ? st.rng.normal(0, spec.positionSigmaM) : 0;
      const ny = spec.positionSigmaM > 0 ? st.rng.normal(0, spec.positionSigmaM) : 0;
      const prev = s.entities.get(id);
      const belief: EntityBelief = { xM: x + nx, yM: y + ny, zM: z, observedAtS: simTimeS, kind, lost: false };
      s.entities.set(id, belief);
      // First sighting, or seen again after being lost: `detected`.
      if (!prev || prev.lost) {
        this.pending.push({ agentId: a.id, event: { kind: "detected", entityId: id, entityKind: kind, xM: belief.xM, yM: belief.yM, zM: belief.zM, observedAtS: simTimeS, transitions: 1 } });
      }
    };
    const ids: { id: string; kind: string; x: number; y: number; z: number }[] = [];
    for (const o of this.objects) ids.push({ id: o.id, kind: o.kind, x: o.position.xM, y: o.position.yM, z: o.position.zM + o.size.heightM / 2 });
    for (const other of this.order) {
      if (other === s) continue;
      const b = other.agent;
      ids.push({ id: b.id, kind: b.kind, x: b.state.x, y: b.state.y, z: b.kind === "uav" ? b.state.z : 0.5 });
    }
    ids.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    for (const e of ids) seen(e.id, e.kind, e.x, e.y, e.z);
  }

  /**
   * The sensing state as plain data (F3a M1; ADR-0035 addition of 2026-10-17, item 8), agents in ID order: the belief
   * map (a large piece the composition stores as a content-addressed section), the entity beliefs in insertion order
   * (it drives the order of `lost` events and so of the inbox), the latest proximity hits, and each sensor's RNG state and
   * dropout. Perception events of the tick are taken by the world within the tick: none may be waiting.
   */
  snapshot(): SensingSnapshot {
    if (this.pending.length > 0) throw new Error("cannot snapshot sensing with perception events not yet taken (snapshots are taken between ticks)");
    return {
      curTick: this.curTick,
      agents: this.order.map((s) => ({
        agentId: s.agent.id,
        belief: s.belief.snapshot(),
        entities: [...s.entities].map(([id, e]): [string, EntityBelief] => [id, { ...e }]),
        proximity: [...s.proximity],
        sensors: s.sensors.map((st) => ({ id: st.spec.id, rng: st.rng.getState(), dropped: st.dropped })),
      })),
    };
  }

  /**
   * Puts a snapshot back in place into a service assembled over the same agents and sensors. Each sensor's `Rng` is set in
   * place (the noise closure keeps drawing from it), the belief map in place (the belief grid, the observer and the planner
   * share it), and the entity beliefs in the order they were in.
   */
  restore(s: SensingSnapshot): void {
    if (s.agents.length !== this.order.length) throw new RangeError(`snapshot has ${s.agents.length} agents' sensing, the run has ${this.order.length}`);
    for (const a of s.agents) {
      const mine = this.byId.get(a.agentId);
      if (!mine) throw new RangeError(`snapshot has sensing for unknown agent ${a.agentId}`);
      if (a.sensors.length !== mine.sensors.length) throw new RangeError(`snapshot has ${a.sensors.length} sensors for ${a.agentId}, the agent has ${mine.sensors.length}`);
      mine.belief.restore(a.belief);
      mine.entities.clear();
      for (const [id, e] of a.entities) mine.entities.set(id, { ...e });
      mine.proximity = [...a.proximity];
      a.sensors.forEach((ss, k) => {
        const st = mine.sensors[k];
        if (!st || st.spec.id !== ss.id) throw new RangeError(`snapshot sensor ${ss.id} of ${a.agentId} is not the agent's ${st?.spec.id}`);
        st.rng.setState(ss.rng);
        st.dropped = ss.dropped;
      });
    }
    this.pending = [];
    this.curTick = s.curTick;
  }

  /** ProximityPort: the agent's latest proximity hit points. */
  hits(agentId: string): readonly number[] {
    return this.byId.get(agentId)?.proximity ?? [];
  }

  /** ContactPort: a bump. The touched cells become believed occupied at the clamp; always traced. */
  contact(agentId: string, cells: readonly number[], lowerM: number, simTime: number): void {
    const s = this.byId.get(agentId);
    if (!s) return;
    for (let k = 0; k + 1 < cells.length; k += 2) s.belief.observeContact(cells[k] ?? 0, cells[k + 1] ?? 0, lowerM);
    this.trace.emit({ source: `${agentId}/sensors`, simTime, kind: "observation", agentId, detail: "full", payload: { op: "contact", cells: [...cells], lowerM } });
  }

  belief(agentId: string): BeliefMap {
    const s = this.byId.get(agentId);
    if (!s) throw new Error(`no sensing state for ${agentId}`);
    return s.belief;
  }

  /** The agent's entity beliefs (read-only view). */
  entities(agentId: string): ReadonlyMap<string, EntityBelief> {
    return this.byId.get(agentId)?.entities ?? new Map();
  }

  /**
   * Beliefs in the state hash (F2 M2b): agents in ID order. The belief map of every agent but the `ideal` ones (whose
   * map is the ground truth and adds nothing), then the entity beliefs of every agent (`ideal` covers the map only),
   * entities in ID order.
   */
  hashInto(h: StateHasher): void {
    for (const s of this.order) {
      const id = s.agent.id;
      if (!this.ideal.has(id)) s.belief.hashInto(h);
      if (s.entities.size === 0) continue;
      h.str(id).u32(s.entities.size);
      for (const eid of [...s.entities.keys()].sort()) {
        const e = s.entities.get(eid) as EntityBelief;
        h.str(eid).f64(e.xM, "entity.x").f64(e.yM, "entity.y").f64(e.zM, "entity.z").f64(e.observedAtS, "entity.t");
      }
    }
  }

  /** Content hash of the agent's belief map (tests). */
  beliefHash(agentId: string): string {
    const h = new StateHasher();
    this.belief(agentId).hashInto(h);
    return h.hex();
  }
}
