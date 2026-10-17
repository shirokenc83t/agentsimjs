import { SearchSpace } from "@agentsim/algorithms";
import type { FrontierCandidate, FrontierPort, StateHasher, TraceSink } from "@agentsim/core";
import { AgentTopology, type FrontierGroup, type PassabilityView, type PlanningGrid } from "@agentsim/spatial";
import type { ResolvedRunConfig } from "../run-config/resolve.ts";

/** Connectivity reads an agent's planning view (ADR-0039 §1): its passability, keyed by traversal and profile. */
export function passabilityOf(space: SearchSpace): PassabilityView {
  return { key: SearchSpace.key(space.traversal, space.profile), passable: (i, j) => space.passable(i, j) };
}

/** Unreachable marks of one agent (ADR-0039 §1 and its addition of 2026-10-10): agent state. */
interface Marks {
  /** Chunk index → marked cells, and the view content version they were marked at. */
  readonly byChunk: Map<number, { readonly cells: Set<number>; at: number }>;
  /** View content version at the last clearing check. */
  checkedAt: number;
  /** Bumped whenever a mark is added or cleared (a change stamp for `watchFrontiers`). */
  rev: number;
}

/**
 * Every agent's topological layer (ADR-0039), over the map it plans on: its belief grid, or the ground truth for
 * `ideal` agents. Updated in the sensing phase, after the readings and the view sync point. The layer itself is
 * derived data; the unreachable marks are agent state (state hash).
 */
export class TopologyService implements FrontierPort {
  private readonly byAgent = new Map<string, AgentTopology>();
  private readonly marks = new Map<string, Marks>();
  /** Per agent: it had an unmarked frontier at the last update (so reaching none is a transition: `frontierExhausted`). */
  private readonly hadFrontier = new Map<string, boolean>();
  /** Per agent: one unmarked frontier group found at the last look, and its region's stamp then. */
  private readonly witness = new Map<string, { readonly region: number; readonly rev: number; readonly group: FrontierGroup }>();
  /** Per agent: the (frontier revision, marks revision) stamp at the last `watchFrontiers` look. */
  private readonly watchedAt = new Map<string, string>();
  /** Agents that ran out of frontiers at the last update, taken by the world once per tick. */
  private exhausted: string[] = [];
  /** Agents with a lidar or proximity sensor (the `hasRangeSensor` precondition). */
  private readonly rangeSensors = new Set<string>();
  /** Agent IDs in ID order (update order). */
  private readonly ids: readonly string[];

  constructor(
    resolved: ResolvedRunConfig,
    mapOf: (agentId: string) => PlanningGrid,
    /** The agent's live planning view (edges, and when marks clear); undefined outside a run (tests). */
    private readonly viewOf: (agentId: string) => SearchSpace | undefined = () => undefined,
    private readonly trace?: { readonly sink: TraceSink; readonly dtS: number },
    /** Where each agent is (to know whether its own position is known on its map). */
    private readonly positionOf: (agentId: string) => { readonly xM: number; readonly yM: number } | undefined = () => undefined,
  ) {
    for (const a of resolved.agents) this.byAgent.set(a.agentId, new AgentTopology(mapOf(a.agentId), a.topology));
    this.ids = resolved.agents.map((a) => a.agentId);
    for (const a of resolved.agents) if (a.body.sensors.some((s) => s.type !== "camera")) this.rangeSensors.add(a.agentId);
    // The first build covers every chunk: done at assembly (load time), never inside a tick.
    this.update();
  }

  /**
   * After sensing and the view sync point: brings every layer up to date, then clears the marks in chunks around
   * which the agent's planning view changed (passability or cost), never on other belief updates.
   */
  update(simTime = 0): void {
    for (const id of this.ids) {
      this.byAgent.get(id)?.update();
      this.clearMarks(id, simTime);
      this.watchFrontiers(id);
    }
  }

  /**
   * `frontierExhausted` (ADR-0005 addition): an agent that had an unmarked frontier group and now has none, with its own
   * position known on its map. It re-arms when frontiers appear again. Evaluated here, at a fixed point of the tick, so
   * a query never triggers it.
   */
  private watchFrontiers(agentId: string): void {
    // Only when the frontier groups or the marks changed since the last look (a per-tick scan of every group cost ~1 ms
    // for 20 agents); a look that ended waiting for the agent's own position is repeated until it is known.
    const stamp = `${this.of(agentId).frontierRevision}:${this.marks.get(agentId)?.rev ?? 0}`;
    if (this.watchedAt.get(agentId) === stamp) return;
    this.watchedAt.set(agentId, stamp);
    const unmarked = this.hasUnmarkedFrontier(agentId);
    if (unmarked) {
      this.hadFrontier.set(agentId, true);
      return;
    }
    if (this.hadFrontier.get(agentId) !== true) return;
    const p = this.positionOf(agentId);
    if (p && !this.isKnown(agentId, p.xM, p.yM)) {
      this.watchedAt.delete(agentId);
      return;
    }
    this.hadFrontier.set(agentId, false);
    this.exhausted.push(agentId);
  }

  /**
   * Whether the agent has any unmarked frontier group: the same answer as regrouping everything, found cheaply. A
   * witness (one unmarked group found last time) still stands while its region's frontier flags are unchanged and it
   * is not marked; otherwise regions are searched with an early exit, and all are regrouped only when none has one.
   */
  hasUnmarkedFrontier(agentId: string): boolean {
    const t = this.of(agentId);
    const w = this.witness.get(agentId);
    if (w && t.regionRevision(w.region) === w.rev && !this.isMarked(agentId, w.group)) return true;
    const start = w?.region ?? 0;
    const n = t.regionCount;
    for (let k = 0; k < n; k++) {
      const r = (start + k) % n;
      for (const g of t.groupsOfRegion(r)) {
        if (this.isMarked(agentId, g)) continue;
        this.witness.set(agentId, { region: r, rev: t.regionRevision(r), group: g });
        return true;
      }
    }
    this.witness.delete(agentId);
    return false;
  }

  /**
   * What the Scene's overlay draws of the agent's topological layer (viewed agent only): the regions' rectangles with their
   * known share (x0, y0, x1, y1 in metres, known %), and the frontier groups (x, y, cells, marked unreachable). Pure
   * reads: frontier groups are the memoized lazy ones (ADR-0039 addition of 2026-10-10), nothing changes.
   */
  overlay(agentId: string, maxRegions = 256, maxFrontiers = 64): { readonly regions: Float32Array; readonly frontiers: Float32Array } {
    const t = this.of(agentId);
    const g = t.grid;
    const res = g.resolutionM;
    const regs = t.regions().slice(0, maxRegions);
    const regions = new Float32Array(regs.length * 5);
    regs.forEach((r, k) => {
      regions.set([r.i0 * res, r.j0 * res, r.i1 * res, r.j1 * res, r.cells > 0 ? Math.round((100 * r.known) / r.cells) : 0], k * 5);
    });
    const groups = t.frontierGroups().slice(0, maxFrontiers);
    const frontiers = new Float32Array(groups.length * 4);
    groups.forEach((f, k) => {
      frontiers.set([g.cellCenterX(f.point % g.sizeX), g.cellCenterY((f.point / g.sizeX) | 0), f.cells.length, this.isMarked(agentId, f) ? 1 : 0], k * 4);
    });
    return { regions, frontiers };
  }

  /** Agents that just ran out of frontiers, in agent-ID order; taken once. */
  takeExhausted(): string[] {
    const out = this.exhausted;
    this.exhausted = [];
    return out;
  }

  of(agentId: string): AgentTopology {
    const t = this.byAgent.get(agentId);
    if (!t) throw new Error(`no topology for ${agentId}`);
    return t;
  }

  // ---- FrontierPort --------------------------------------------------------------------------------

  hasRangeSensor(agentId: string): boolean {
    return this.rangeSensors.has(agentId);
  }

  hasRegion(agentId: string, region: string): boolean {
    return this.regionIndex(agentId, region) >= 0;
  }

  regionRect(agentId: string, region: string): { x0: number; y0: number; x1: number; y1: number } | undefined {
    const t = this.of(agentId);
    const r = this.regionIndex(agentId, region);
    if (r < 0) return undefined;
    const info = t.region(r);
    const res = t.grid.resolutionM;
    return { x0: info.i0 * res, y0: info.j0 * res, x1: info.i1 * res, y1: info.j1 * res };
  }

  candidates(agentId: string): FrontierCandidate[] {
    const t = this.of(agentId);
    const g = t.grid;
    return t
      .frontierGroups()
      .filter((f) => !this.isMarked(agentId, f))
      .map((f) => ({ id: f.id, region: f.region, cells: f.cells, point: f.point, xM: g.cellCenterX(f.point % g.sizeX), yM: g.cellCenterY((f.point / g.sizeX) | 0) }));
  }

  markedCount(agentId: string): number {
    return this.of(agentId)
      .frontierGroups()
      .filter((f) => this.isMarked(agentId, f)).length;
  }

  isFrontier(agentId: string, cell: number): boolean {
    return this.of(agentId).isFrontierCell(cell);
  }

  isKnown(agentId: string, xM: number, yM: number): boolean {
    const g = this.of(agentId).grid;
    const i = g.cellI(xM);
    const j = g.cellJ(yM);
    return g.inBounds(i, j) && !g.isUnknown(i, j);
  }

  /**
   * Whether the region still has unknown cells worth exploring and within reach (explore's end condition):
   * (a) an unknown cell of the region borders a frontier cell of an unmarked group (groups below `minFrontierCells`
   *     are sensor noise, ADR-0039 §1), or
   * (b) the region has unknown cells with no known neighbour (space the agent has not seen) and it is connected to
   *     the agent's region in the region graph (either edge class: reachable through unknown space).
   * Leftover unknown cells next to noise-sized frontiers do not keep a region open. Whether a frontier is actually
   * reachable is settled by the planner (marks).
   */
  regionHasReachableUnknown(agentId: string, region: string, xM: number, yM: number): boolean {
    const t = this.of(agentId);
    const target = this.regionIndex(agentId, region);
    if (target < 0) return false;
    const info = t.region(target);
    if (info.known >= info.cells) return false;
    const g = t.grid;
    const frontier = new Set<number>();
    for (const f of t.frontierGroups()) if (!this.isMarked(agentId, f)) for (const c of f.cells) frontier.add(c);
    let unseen = false;
    for (let j = info.j0; j < info.j1; j++) {
      for (let i = info.i0; i < info.i1; i++) {
        if (!g.isUnknown(i, j)) continue;
        let knownNeighbour = false;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const a = i + di;
          const b = j + dj;
          if (!g.inBounds(a, b) || g.isUnknown(a, b)) continue;
          knownNeighbour = true;
          if (frontier.has(b * g.sizeX + a)) return true; // (a)
        }
        if (!knownNeighbour) unseen = true;
      }
    }
    return unseen && this.connected(agentId, xM, yM, target); // (b)
  }

  /** Whether `target` is connected to the agent's region in the region graph (edges of either class). */
  private connected(agentId: string, xM: number, yM: number, target: number): boolean {
    const t = this.of(agentId);
    const view = this.viewOf(agentId);
    if (!view) return true;
    const g = t.grid;
    const own = t.regionOfCell(Math.min(g.sizeX - 1, Math.max(0, g.cellI(xM))), Math.min(g.sizeY - 1, Math.max(0, g.cellJ(yM))));
    if (own === target) return true;
    const ids = t.regions().map((r) => r.id);
    const index = new Map(ids.map((id, k) => [id, k]));
    const adj: number[][] = ids.map(() => []);
    for (const e of t.edges(passabilityOf(view))) {
      const a = index.get(e.a) ?? -1;
      const b = index.get(e.b) ?? -1;
      adj[a]?.push(b);
      adj[b]?.push(a);
    }
    const seen = new Uint8Array(ids.length);
    seen[own] = 1;
    const queue = [own];
    for (let q = 0; q < queue.length; q++) {
      for (const n of (adj[queue[q] ?? 0] ?? []).sort((x, y) => x - y)) {
        if (seen[n] === 1) continue;
        if (n === target) return true;
        seen[n] = 1;
        queue.push(n);
      }
    }
    return false;
  }

  markAt(agentId: string, xM: number, yM: number, simTime: number): boolean {
    const t = this.of(agentId);
    const g = t.grid;
    const i = g.cellI(xM);
    const j = g.cellJ(yM);
    if (!g.inBounds(i, j)) return false;
    const cell = j * g.sizeX + i;
    const group = t.frontierGroups().find((f) => f.cells.includes(cell));
    if (!group) return false;
    const m = this.marksOf(agentId);
    const at = this.viewOf(agentId)?.contentVersion ?? 0;
    const cs = g.chunkSize;
    for (const c of group.cells) {
      const k = (((c / g.sizeX) | 0) / cs | 0) * g.chunksX + (((c % g.sizeX) / cs) | 0);
      let entry = m.byChunk.get(k);
      if (!entry) {
        entry = { cells: new Set(), at };
        m.byChunk.set(k, entry);
      }
      entry.cells.add(c);
      entry.at = at;
    }
    m.rev++;
    this.emit(agentId, simTime, { op: "frontier-mark", group: group.point, region: group.region, cells: group.cells.length });
    return true;
  }

  /** Marks are agent state: added to the state hash only for agents that have any (runs without marks unchanged). */
  hashInto(h: StateHasher): void {
    for (const id of this.ids) {
      const m = this.marks.get(id);
      if (!m || m.byChunk.size === 0) continue;
      const cells: number[] = [];
      for (const e of m.byChunk.values()) for (const c of e.cells) cells.push(c);
      cells.sort((a, b) => a - b);
      h.str(id).u32(cells.length);
      for (const c of cells) h.u32(c);
    }
  }

  // ---- internals -----------------------------------------------------------------------------------

  private regionIndex(agentId: string, region: string): number {
    const t = this.of(agentId);
    const m = /^r-(\d+)-(\d+)$/.exec(region);
    if (!m) return -1;
    const col = Number(m[1]);
    const row = Number(m[2]);
    if (col >= t.regionsX || row >= t.regionsY || t.regionId(col, row) !== region) return -1;
    return row * t.regionsX + col;
  }

  private marksOf(agentId: string): Marks {
    let m = this.marks.get(agentId);
    if (!m) {
      m = { byChunk: new Map(), checkedAt: this.viewOf(agentId)?.contentVersion ?? 0, rev: 0 };
      this.marks.set(agentId, m);
    }
    return m;
  }

  /** Whether a frontier group is marked unreachable for the agent (read-only; used by the mind view). */
  isMarkedGroup(agentId: string, f: FrontierGroup): boolean {
    return this.isMarked(agentId, f);
  }

  /** A group is marked when all its cells are (a group that grew into new cells is a candidate again). */
  private isMarked(agentId: string, f: FrontierGroup): boolean {
    const m = this.marks.get(agentId);
    if (!m || m.byChunk.size === 0) return false;
    const t = this.of(agentId);
    const g = t.grid;
    const cs = g.chunkSize;
    for (const c of f.cells) {
      const k = (((c / g.sizeX) | 0) / cs | 0) * g.chunksX + (((c % g.sizeX) / cs) | 0);
      if (!m.byChunk.get(k)?.cells.has(c)) return false;
    }
    return true;
  }

  /** Clears marks in chunks where the agent's planning view changed in the chunk or its 8 neighbours. */
  private clearMarks(agentId: string, simTime: number): void {
    const m = this.marks.get(agentId);
    if (!m || m.byChunk.size === 0) return; // no view is built for an agent without marks
    const view = this.viewOf(agentId);
    if (!view) return;
    if (view.contentVersion === m.checkedAt) return;
    const changed = new Set(view.changedSince(m.checkedAt));
    m.checkedAt = view.contentVersion;
    const g = this.of(agentId).grid;
    for (const k of [...m.byChunk.keys()].sort((a, b) => a - b)) {
      const ci = k % g.chunksX;
      const cj = (k / g.chunksX) | 0;
      let hit = false;
      for (let dj = -1; dj <= 1 && !hit; dj++) for (let di = -1; di <= 1 && !hit; di++) if (changed.has((cj + dj) * g.chunksX + (ci + di)) && ci + di >= 0 && ci + di < g.chunksX) hit = true;
      if (!hit) continue;
      const cells = m.byChunk.get(k)?.cells.size ?? 0;
      m.byChunk.delete(k);
      m.rev++;
      this.emit(agentId, simTime, { op: "frontier-unmark", chunk: k, cells });
    }
  }

  private emit(agentId: string, simTime: number, payload: unknown): void {
    this.trace?.sink.emit({ source: `${agentId}/beliefs`, simTime, kind: "event", agentId, detail: "transitions", payload });
  }
}
