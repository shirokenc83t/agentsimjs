import { GridSearch, type SearchStatus } from "../grid/grid-search.ts";
import { NodeTable, OpenHeap } from "../grid/node-table.ts";
import type { AbstractGraph } from "./abstract-graph.ts";

type Phase = "insert-start" | "insert-goal" | "abstract" | "refine" | "done";

/**
 * Resumable HPA* query (ADR-0024): a state machine over phases, each charging its expansions against the
 * query's budget — start insertion (exhaustive search inside the start cluster), goal insertion (reverse
 * search inside the goal cluster), A* on the abstract graph, then refinement of each intra-cluster
 * segment with A* inside its cluster. The abstract graph itself is precomputed (no sim time).
 */
export class HpaQuery {
  status: SearchStatus = "running";
  expanded = 0;
  cost = Number.POSITIVE_INFINITY;
  private phase: Phase = "insert-start";
  private readonly startSearch: GridSearch;
  private readonly goalSearch: GridSearch;
  private readonly startCluster: number;
  private readonly goalCluster: number;
  private readonly START: number;
  private readonly GOAL: number;
  // abstract A*
  private readonly nodes = new NodeTable(256);
  private readonly open = new OpenHeap();
  private abstractPath: number[] = [];
  // refinement
  private segment = 0;
  private cells: number[] = [];

  /**
   * `opts.coarseOnly` ends the query when the abstract path is found (status `found`, `path()` empty) and exposes it as
   * `coarseCells()`: the coarse node of a `refine` strategy (ADR-0037 addition of 2026-10-13, §6). Refinement costs no
   * expansions (ADR-0024), so a coarse query charges exactly what the full one does.
   */
  constructor(
    private readonly graph: AbstractGraph,
    readonly startCell: number,
    readonly goalCell: number,
    readonly totalBudget: number,
    private readonly opts: { readonly coarseOnly?: boolean } = {},
  ) {
    const s = graph.space;
    this.START = s.sizeX * s.sizeY;
    this.GOAL = this.START + 1;
    this.startCluster = graph.clusterOfCell(startCell);
    this.goalCluster = graph.clusterOfCell(goalCell);
    // Insertion searches stop once the cluster's abstract nodes (and, in a shared cluster, the goal) are settled.
    const startTargets = [...graph.nodesOf(this.startCluster)];
    if (this.startCluster === this.goalCluster) startTargets.push(goalCell);
    this.startSearch = new GridSearch(s, startCell, -1, { kind: "dijkstra" }, Number.MAX_SAFE_INTEGER, {
      bounds: graph.clusterBounds(this.startCluster),
      settleTargets: startTargets,
    });
    this.goalSearch = new GridSearch(s, goalCell, -1, { kind: "dijkstra" }, Number.MAX_SAFE_INTEGER, {
      bounds: graph.clusterBounds(this.goalCluster),
      reverse: true,
      settleTargets: graph.nodesOf(this.goalCluster),
    });
    if (s.mask[startCell] === 0 || s.mask[goalCell] === 0) this.status = "not_found";
  }

  private cellXY(cell: number): [number, number] {
    const sx = this.graph.space.sizeX;
    return [cell % sx, (cell / sx) | 0];
  }

  private h(cell: number): number {
    if (cell === this.GOAL) return 0;
    const [i, j] = this.cellXY(cell === this.START ? this.startCell : cell);
    const [gi, gj] = this.cellXY(this.goalCell);
    return this.graph.space.heuristic(i, j, gi, gj);
  }

  /** Charges `n` expansions; returns false (and sets budget_exceeded) if the total budget is exhausted. */
  private charge(n: number): boolean {
    this.expanded += n;
    if (this.expanded > this.totalBudget) {
      this.expanded = this.totalBudget;
      this.status = "budget_exceeded";
      return false;
    }
    return true;
  }

  step(maxExpansions: number): SearchStatus {
    let budget = maxExpansions;
    // Every phase either consumes budget or advances (phase/segment), so the loop always terminates.
    while (this.status === "running" && budget > 0) {
      switch (this.phase) {
        case "insert-start":
          budget -= this.advanceSub(this.startSearch, budget, "insert-goal");
          break;
        case "insert-goal":
          budget -= this.advanceSub(this.goalSearch, budget, "abstract");
          break;
        case "abstract":
          budget -= this.abstractStep(budget);
          break;
        case "refine":
          budget -= this.refineStep(budget);
          break;
        case "done":
          return this.status;
      }
    }
    return this.status;
  }

  /** Steps an exhaustive cluster search; moves to `next` when it has settled every reachable cell. */
  private advanceSub(search: GridSearch, budget: number, next: Phase): number {
    const before = search.expanded;
    search.step(Math.min(budget, this.totalBudget - this.expanded + 1));
    const used = search.expanded - before;
    if (!this.charge(used)) return used;
    if (search.status !== "running") {
      this.phase = next; // exhaustive: ends as not_found once every reachable cell is settled
      if (next === "abstract") this.initAbstract();
    }
    return used;
  }

  private initAbstract(): void {
    const slot = this.nodes.insert(this.START);
    this.nodes.g[slot] = 0;
    this.open.push(this.h(this.START), this.h(this.START), this.START);
  }

  private successors(u: number): { to: number; cost: number }[] {
    if (u === this.START) {
      const out: { to: number; cost: number }[] = [];
      for (const v of this.graph.nodesOf(this.startCluster)) {
        const c = this.startSearch.costTo(v);
        if (c !== Number.POSITIVE_INFINITY) out.push({ to: v, cost: c });
      }
      if (this.startCluster === this.goalCluster) {
        const d = this.startSearch.costTo(this.goalCell);
        if (d !== Number.POSITIVE_INFINITY) out.push({ to: this.GOAL, cost: d });
      }
      return out;
    }
    const out = this.graph.edgesFrom(u).map((e) => ({ to: e.to, cost: e.cost }));
    if (this.graph.clusterOfCell(u) === this.goalCluster) {
      const c = this.goalSearch.costTo(u);
      if (c !== Number.POSITIVE_INFINITY) out.push({ to: this.GOAL, cost: c });
    }
    return out;
  }

  private abstractStep(budget: number): number {
    let used = 0;
    while (used < budget) {
      if (this.open.size === 0) {
        this.status = "not_found";
        this.phase = "done";
        return used;
      }
      const u = this.open.pop();
      const slot = this.nodes.find(u);
      if (slot < 0 || this.nodes.closed[slot] === 1) continue;
      if (!this.charge(1)) return used + 1;
      used++;
      this.nodes.closed[slot] = 1;
      if (u === this.GOAL) {
        this.cost = this.nodes.g[slot] ?? Number.POSITIVE_INFINITY;
        const path: number[] = [];
        let s = u;
        while (s >= 0) {
          path.push(s);
          const sl = this.nodes.find(s);
          s = sl < 0 ? -1 : (this.nodes.parent[sl] ?? -1);
        }
        this.abstractPath = path.reverse();
        if (this.opts.coarseOnly) {
          this.status = "found";
          this.phase = "done";
        } else this.phase = "refine";
        return used;
      }
      const g = this.nodes.g[slot] ?? 0;
      for (const e of this.successors(u)) {
        let ns = this.nodes.find(e.to);
        if (ns < 0) ns = this.nodes.insert(e.to);
        else if (this.nodes.closed[ns] === 1) continue;
        const ng = g + e.cost;
        if (ng < (this.nodes.g[ns] ?? Number.POSITIVE_INFINITY)) {
          this.nodes.g[ns] = ng;
          this.nodes.parent[ns] = u;
          const h = this.h(e.to);
          this.open.push(ng + h, h, e.to);
        }
      }
    }
    return used;
  }

  /** Refines abstract path segments into cells; START/GOAL segments reuse the insertion searches. */
  private refineStep(budget: number): number {
    const used = 0;
    const ap = this.abstractPath;
    while (used < budget) {
      if (this.segment >= ap.length - 1) {
        this.status = "found";
        this.phase = "done";
        return used;
      }
      const a = ap[this.segment] ?? -1;
      const b = ap[this.segment + 1] ?? -1;
      let seg: number[];
      if (a === this.START && b === this.GOAL) seg = this.startSearch.pathTo(this.goalCell);
      else if (a === this.START) seg = this.startSearch.pathTo(b);
      else if (b === this.GOAL) seg = this.goalSearch.pathTo(a).reverse();
      else if (this.graph.clusterOfCell(a) !== this.graph.clusterOfCell(b)) seg = [a, b]; // inter-cluster step
      else {
        // Intra-cluster edge: its path was precomputed with the graph (no expansions, ADR-0024).
        const p = this.graph.intraPath(a, b);
        if (!p) throw new Error(`abstract edge ${a} -> ${b} has no stored path`);
        seg = p;
      }
      for (const c of seg) if (this.cells.at(-1) !== c) this.cells.push(c);
      this.segment++;
    }
    return used;
  }

  path(): number[] {
    return this.status === "found" ? this.cells : [];
  }

  /**
   * The abstract path as grid cells: the start, the entrance cells of the clusters it crosses, the goal. Empty until the
   * abstract phase has found it.
   */
  coarseCells(): number[] {
    return this.abstractPath.map((n) => (n === this.START ? this.startCell : n === this.GOAL ? this.goalCell : n));
  }
}
