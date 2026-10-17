import { compileCostProfile, DEFAULT_COST_PROFILE, SearchSpace } from "@agentsim/algorithms";
import type { SimAgent, TraceSink } from "@agentsim/core";
import { BELIEF_FREE, BELIEF_OCCUPIED, type BeliefMap, type GridSpace } from "@agentsim/spatial";
import type { LoadedObject } from "../load.ts";
import type { ResolvedRunConfig } from "../run-config/resolve.ts";
import { traversalFor } from "../traversal.ts";
import type { SensingService } from "./sensing.ts";

/** Per-chunk tally slots. */
const CORRECT = 0;
const PHANTOM = 1;
const UNKNOWN = 2;
const FALSE_FREE = 3;
const BELIEVED_FREE = 4;
const HEIGHT_VIOLATION = 5;
const SLOTS = 6;

/** DDA-free 8-connected moves of the planner's grid search: a diagonal needs both side cells (no corner cutting). */
const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;

/**
 * How well an agent's belief map matches the truth over the cells it could actually reach. Percentages are of the
 * agent's reachable cells (`correct + phantom + unknown = 100`), except `falseFreePct`, which is of the cells it
 * believes free.
 */
export interface MapMetrics {
  /** Cells in the agent's connected component of the ground truth under its own traversal rules. */
  readonly reachableCells: number;
  /** Reachable cells believed free. */
  readonly correctPct: number;
  /** Reachable cells believed occupied (the belief is wrong: a wall that is not there). */
  readonly phantomPct: number;
  /** Reachable cells the agent knows nothing about. */
  readonly unknownPct: number;
  /** Cells believed free that are truly blocked (at the agent's altitude, for a UAV): the dangerous error. */
  readonly falseFreeCells: number;
  readonly falseFreePct: number;
  /** UAV only: cells believed an obstacle whose believed top is lower than the true top. */
  readonly heightViolations: number;
}

export interface EntityMetrics {
  /** Scenario objects plus the other agents. */
  readonly total: number;
  readonly known: number;
  /** Distance between believed and true positions of the known entities (m). */
  readonly meanErrM: number;
  readonly maxErrM: number;
}

export interface BeliefVsTruthReport {
  readonly agentId: string;
  readonly tick: number;
  readonly simTimeS: number;
  /** Absent for `ideal` agents: their map is the ground truth. */
  readonly map?: MapMetrics;
  readonly entities: EntityMetrics;
}

/** An element of a typed array that is known to be in range. */
function at(a: Int32Array, k: number): number {
  return a[k] ?? 0;
}

/** Percentage with two decimals, from integers (deterministic, no float accumulation). */
function pct(a: number, b: number): number {
  return b <= 0 ? 0 : Math.round((10000 * a) / b) / 100;
}

interface Tracker {
  readonly agent: SimAgent;
  readonly belief: BeliefMap;
  readonly view: Labels;
  label: number;
  reach: Int32Array;
  /** Per chunk: tallies of the last look (SLOTS per chunk), and the running totals over all chunks. */
  readonly tally: Int32Array;
  readonly total: Int32Array;
  seenVersion: number;
}

/** Connected-component labels of the ground truth under one traversal (the planner's rules), shared by its agents. */
interface Labels {
  readonly labels: Int32Array;
  readonly mask: Uint8Array;
  /** Reachable cells per chunk for a label, built on demand. */
  readonly perChunk: Map<number, Int32Array>;
}

/** The state of the observer between ticks, as plain data (see `snapshot`). */
export interface ObserverSnapshot {
  /** Per agent in run order: the sim time of its next sample. */
  readonly dueS: readonly number[];
  /** Per agent with a belief map: the connected component of the truth it is counted in (0: none yet). History, see `restore`. */
  readonly labels: readonly (readonly [string, number])[];
}

/**
 * Observer-side comparison of beliefs and ground truth (ADR-0005 addition of 2026-10-11, M2d4). **It never reaches a
 * mind**: nothing here is part of a `DecisionRequest` or a `MindView`, and no mind-facing module imports it. It is for
 * the trace, the Inspector and the benchmarks.
 *
 * Reachability uses the agent's own planner rules applied to the ground truth: 8-connected moves without corner
 * cutting, over the traversal's inflated mask (footprint + inflation; for a UAV, in-bounds cells not blocked at its
 * altitude and outside no-fly zones), from the agent's current connected component. Tallies are kept per belief chunk
 * and refreshed only for chunks that changed since the previous look, so a look costs what changed, not the map.
 */
export class BeliefVsTruth {
  private readonly trackers = new Map<string, Tracker>();
  private readonly order: string[];
  private readonly labelsByKey = new Map<string, Labels>();
  private readonly byId: ReadonlyMap<string, SimAgent>;
  /** Scratch: believed states of one chunk. */
  private readonly classes: Uint8Array;
  /** Per agent (in `order`): the sim time of its next sample. Staggered across the interval so one tick looks at one agent. */
  private readonly dueS: number[];

  constructor(
    private readonly truth: GridSpace,
    agents: readonly SimAgent[],
    private readonly objects: readonly LoadedObject[],
    private readonly sensing: SensingService,
    resolved: ResolvedRunConfig,
    private readonly sink?: TraceSink,
    /** Sim seconds between trace samples (default 10). */
    private readonly everyS = 10,
  ) {
    this.byId = new Map(agents.map((a) => [a.id, a]));
    this.order = resolved.agents.map((a) => a.agentId);
    this.dueS = this.order.map((_, n) => (n * everyS) / this.order.length);
    const cs = truth.chunkSize;
    this.classes = new Uint8Array(cs * cs);
    const nChunks = Math.ceil(truth.sizeX / cs) * Math.ceil(truth.sizeY / cs);
    for (const cfg of resolved.agents) {
      if (cfg.beliefs.idealized) continue;
      const agent = this.byId.get(cfg.agentId);
      if (!agent) continue;
      const profile = compileCostProfile(cfg.planning.costProfile ?? DEFAULT_COST_PROFILE);
      if (!profile.ok) throw new Error(`cost profile of ${cfg.agentId}: ${profile.error.message}`);
      const traversal = traversalFor(cfg);
      const key = SearchSpace.key(traversal, profile.value);
      let view = this.labelsByKey.get(key);
      if (!view) {
        view = this.label(new SearchSpace(truth, traversal, profile.value));
        this.labelsByKey.set(key, view);
      }
      this.trackers.set(cfg.agentId, {
        agent,
        belief: sensing.belief(cfg.agentId),
        view,
        label: 0,
        reach: new Int32Array(nChunks),
        tally: new Int32Array(nChunks * SLOTS),
        total: new Int32Array(SLOTS),
        seenVersion: 0,
      });
      this.assign(this.trackers.get(cfg.agentId) as Tracker);
    }
  }

  /** Metrics for one agent at the current state. */
  report(agentId: string, tick: number, simTimeS: number): BeliefVsTruthReport {
    const entities = this.entityMetrics(agentId);
    const t = this.trackers.get(agentId);
    if (!t) return { agentId, tick, simTimeS, entities };
    this.assign(t);
    this.refresh(t);
    const reachable = at(t.total, CORRECT) + at(t.total, PHANTOM) + at(t.total, UNKNOWN);
    return {
      agentId,
      tick,
      simTimeS,
      entities,
      map: {
        reachableCells: reachable,
        correctPct: pct(at(t.total, CORRECT), reachable),
        phantomPct: pct(at(t.total, PHANTOM), reachable),
        unknownPct: pct(at(t.total, UNKNOWN), reachable),
        falseFreeCells: at(t.total, FALSE_FREE),
        falseFreePct: pct(at(t.total, FALSE_FREE), at(t.total, BELIEVED_FREE)),
        heightViolations: at(t.total, HEIGHT_VIOLATION),
      },
    };
  }

  /**
   * The observer's state between ticks as plain data (F3a M1; ADR-0035 addition of 2026-10-17, item 8): when each
   * agent's next sample is due, which decides when its trace records appear, and the component each agent is counted in.
   * The tallies are derived from the belief maps and the truth, and are not captured.
   */
  snapshot(): ObserverSnapshot {
    return { dueS: [...this.dueS], labels: [...this.trackers].map(([id, t]): [string, number] => [id, t.label]) };
  }

  /** Puts the sample schedule and the components back in place; the tallies are counted again from the restored maps. */
  restore(s: ObserverSnapshot): void {
    if (s.dueS.length !== this.dueS.length) throw new RangeError(`snapshot has ${s.dueS.length} sample times, the observer has ${this.dueS.length} agents`);
    s.dueS.forEach((d, n) => {
      this.dueS[n] = d;
    });
    for (const [id, label] of s.labels) {
      const t = this.trackers.get(id);
      if (!t) throw new RangeError(`snapshot has an observer label for unknown agent ${id}`);
      // The component an agent is counted in follows it only where it stands on a cell that has one: an agent that stands
      // on none keeps the last, so the label is history, not derivable from where the agent is now.
      if (label > 0) this.useLabel(t, label);
      else {
        t.label = 0;
        t.reach = new Int32Array(t.reach.length);
        t.seenVersion = 0;
        t.tally.fill(0);
        t.total.fill(0);
      }
    }
  }

  /** Forgets the incremental tallies and counts every chunk again: what the incremental path must always equal (tests). */
  recompute(agentId: string): void {
    const t = this.trackers.get(agentId);
    if (!t) return;
    t.label = 0;
  }

  /**
   * Records each agent's sample every `everyS` of sim time. The agents' phases are spread over the interval by their
   * position in agent-ID order (agent n is first due at n · everyS / agents), so a tick looks at about one agent and the
   * cost never arrives as one spike; the phase depends only on the run's agent list.
   */
  sample(tick: number, simTimeS: number): void {
    if (!this.sink) return;
    for (let n = 0; n < this.order.length; n++) {
      if (simTimeS + 1e-9 < (this.dueS[n] as number)) continue;
      while ((this.dueS[n] as number) <= simTimeS + 1e-9) this.dueS[n] = (this.dueS[n] as number) + this.everyS;
      const id = this.order[n] as string;
      const r = this.report(id, tick, simTimeS);
      this.sink.emit({ source: "world/sim", simTime: simTimeS, kind: "event", agentId: id, detail: "transitions", payload: { op: "belief-vs-truth", ...(r.map ? { map: r.map } : { ideal: true }), entities: r.entities } });
    }
  }

  // ---- reachability ---------------------------------------------------------------------------------

  /** Labels the connected components of the traversal's mask: 8-connected, no corner cutting. 0 = not passable. */
  private label(space: SearchSpace): Labels {
    const sx = space.sizeX;
    const sy = space.sizeY;
    const mask = space.mask;
    const labels = new Int32Array(sx * sy);
    const queue = new Int32Array(sx * sy);
    let next = 0;
    for (let s = 0; s < labels.length; s++) {
      if (mask[s] === 0 || labels[s] !== 0) continue;
      next++;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      labels[s] = next;
      while (head < tail) {
        const c = queue[head++] as number;
        const i = c % sx;
        const j = (c / sx) | 0;
        for (let d = 0; d < 8; d++) {
          const ni = i + (DX[d] as number);
          const nj = j + (DY[d] as number);
          if (ni < 0 || nj < 0 || ni >= sx || nj >= sy) continue;
          const n = nj * sx + ni;
          if (mask[n] === 0 || labels[n] !== 0) continue;
          if ((DX[d] as number) !== 0 && (DY[d] as number) !== 0 && (mask[j * sx + ni] === 0 || mask[nj * sx + i] === 0)) continue;
          labels[n] = next;
          queue[tail++] = n;
        }
      }
    }
    return { labels, mask, perChunk: new Map() };
  }

  /** Follows the agent into its current component (it can change when a UAV takes off); recounts when it does. */
  private assign(t: Tracker): void {
    const g = this.truth;
    const i = g.cellI(t.agent.state.x);
    const j = g.cellJ(t.agent.state.y);
    let label = 0;
    // The agent's own cell can lie in an inflated-out cell (it hugs a wall): look at its 3 × 3 neighbourhood.
    for (let dj = -1; dj <= 1 && label === 0; dj++) {
      for (let di = -1; di <= 1 && label === 0; di++) {
        if (g.inBounds(i + di, j + dj)) label = t.view.labels[(j + dj) * g.sizeX + i + di] ?? 0;
      }
    }
    if (label === 0 || label === t.label) return;
    this.useLabel(t, label);
  }

  /** Counts for a component from scratch: every reachable cell is unknown until the chunks that hold observations are recounted. */
  private useLabel(t: Tracker, label: number): void {
    const g = this.truth;
    t.label = label;
    let reach = t.view.perChunk.get(label);
    if (!reach) {
      const cs = g.chunkSize;
      const chunksX = Math.ceil(g.sizeX / cs);
      reach = new Int32Array(Math.ceil(g.sizeY / cs) * chunksX);
      for (let jj = 0; jj < g.sizeY; jj++) {
        const row = (jj / cs | 0) * chunksX;
        for (let ii = 0; ii < g.sizeX; ii++) if (t.view.labels[jj * g.sizeX + ii] === label) {
          const slot = row + ((ii / cs) | 0);
          reach[slot] = (reach[slot] ?? 0) + 1;
        }
      }
      t.view.perChunk.set(label, reach);
    }
    t.reach = reach;
    // A different component: nothing is looked at yet, so every reachable cell counts as unknown until the chunks that
    // hold observations are recounted (a belief chunk that was never touched is all unknown: no scan needed).
    t.seenVersion = 0;
    t.tally.fill(0);
    t.total.fill(0);
    let sum = 0;
    for (let k = 0; k < reach.length; k++) {
      t.tally[k * SLOTS + UNKNOWN] = reach[k] as number;
      sum += reach[k] as number;
    }
    t.total[UNKNOWN] = sum;
  }

  /** Recounts the chunks whose belief changed since the previous look; unmaterialized chunks are all-unknown. */
  private refresh(t: Tracker): void {
    const g = this.truth;
    const cs = g.chunkSize;
    const chunksX = Math.ceil(g.sizeX / cs);
    const dirty = t.belief.chunksChangedSince(t.seenVersion);
    t.seenVersion = t.belief.version;
    const uav = t.agent.kind === "uav";
    const alt = uav ? t.agent.state.z : 0;
    const clearance = uav ? (t.agent.body as { clearanceM?: number }).clearanceM ?? 0 : 0;
    const labels = t.view.labels;
    const belief = t.belief;
    for (const k of dirty) {
      const ci = k % chunksX;
      const cj = (k / chunksX) | 0;
      const i0 = ci * cs;
      const j0 = cj * cs;
      const i1 = Math.min(g.sizeX, i0 + cs);
      const j1 = Math.min(g.sizeY, j0 + cs);
      let correct = 0;
      let phantom = 0;
      let unknown = 0;
      let falseFree = 0;
      let believedFree = 0;
      let heightViolations = 0;
      // A chunk that was never observed is all unknown: only the reachable count matters.
      const observed = belief.classifyChunk(ci, cj, this.classes);
      for (let j = j0; j < j1 && observed; j++) {
        for (let i = i0; i < i1; i++) {
          const s = this.classes[(j - j0) * cs + (i - i0)] ?? 0;
          const reachable = labels[j * g.sizeX + i] === t.label;
          if (reachable) {
            if (s === BELIEF_FREE) correct++;
            else if (s === BELIEF_OCCUPIED) phantom++;
            else unknown++;
          }
          if (s === BELIEF_FREE) {
            believedFree++;
            // Truly blocked: an occupied cell, and for a UAV one whose top reaches its altitude.
            if (g.isBlocked(i, j) && (!uav || g.obstacleTopM(i, j) + clearance > alt)) falseFree++;
          } else if (uav && s === BELIEF_OCCUPIED && g.isBlocked(i, j)) {
            if (belief.knownMaxM(i, j) < g.obstacleTopM(i, j) - 1e-9) heightViolations++;
          }
        }
      }
      if (!observed) unknown = at(t.reach, k);
      const base = k * SLOTS;
      const next = [correct, phantom, unknown, falseFree, believedFree, heightViolations];
      for (let n = 0; n < SLOTS; n++) {
        t.total[n] = (t.total[n] ?? 0) + (next[n] as number) - (t.tally[base + n] ?? 0);
        t.tally[base + n] = next[n] as number;
      }
    }
  }

  // ---- entities -------------------------------------------------------------------------------------

  private entityMetrics(agentId: string): EntityMetrics {
    const truth = new Map<string, { x: number; y: number; z: number }>();
    for (const o of this.objects) truth.set(o.id, { x: o.position.xM, y: o.position.yM, z: o.position.zM });
    for (const [id, a] of this.byId) if (id !== agentId) truth.set(id, { x: a.state.x, y: a.state.y, z: a.kind === "uav" ? a.state.z : 0 });
    let known = 0;
    let sum = 0;
    let max = 0;
    for (const [id, e] of this.sensing.entities(agentId)) {
      const t = truth.get(id);
      if (!t) continue;
      known++;
      const d = Math.hypot(e.xM - t.x, e.yM - t.y, e.zM - t.z);
      sum += d;
      if (d > max) max = d;
    }
    return { total: truth.size, known, meanErrM: known === 0 ? 0 : Math.round((sum / known) * 100) / 100, maxErrM: Math.round(max * 100) / 100 };
  }
}
