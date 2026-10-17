import type { Octant, SpaceSummary } from "@agentsim/core";
import type { AgentTopology, FrontierGroup, PassabilityView } from "./topology.ts";

/** Round half up of 100 · a / b, in integers (b > 0). */
function pct(a: number, b: number): number {
  return b <= 0 ? 0 : Math.floor((200 * a + b) / (2 * b));
}

/** tan(22.5°): octant boundaries from coordinate comparisons, no trigonometry at run time. */
const TAN_22_5 = 0.41421356237309503;

export function octantOf(dx: number, dy: number): Octant {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay <= TAN_22_5 * ax) return dx >= 0 ? "E" : "W";
  if (ax <= TAN_22_5 * ay) return dy >= 0 ? "N" : "S";
  if (dx >= 0) return dy >= 0 ? "NE" : "SE";
  return dy >= 0 ? "NW" : "SW";
}

/**
 * The bounded summary a mind receives as `space` (ADR-0039 §2), the same for every mind: the agent's region, up
 * to `maxRegions` regions (its own, then by hops in the region graph, then by ID) and up to `maxFrontiers`
 * unmarked frontier groups (by straight-line distance, then ID), with counts of what was left out.
 */
export function buildSpaceSummary(
  topo: AgentTopology,
  view: PassabilityView,
  agent: { readonly xM: number; readonly yM: number },
  isMarked: (g: FrontierGroup) => boolean = () => false,
): SpaceSummary {
  const g = topo.grid;
  const res = g.resolutionM;
  const cfg = topo.config;
  const ai = Math.min(g.sizeX - 1, Math.max(0, g.cellI(agent.xM)));
  const aj = Math.min(g.sizeY - 1, Math.max(0, g.cellJ(agent.yM)));
  const own = topo.regionOfCell(ai, aj);
  const infos = topo.regions();
  const edges = topo.edges(view);

  // Hops in the region graph (both edge classes), breadth-first from the agent's region.
  const index = new Map(infos.map((r, k) => [r.id, k]));
  const adj: number[][] = infos.map(() => []);
  for (const e of edges) {
    const a = index.get(e.a) ?? -1;
    const b = index.get(e.b) ?? -1;
    adj[a]?.push(b);
    adj[b]?.push(a);
  }
  for (const l of adj) l.sort((x, y) => x - y);
  const hops = new Int32Array(infos.length).fill(-1);
  hops[own] = 0;
  const queue = [own];
  for (let q = 0; q < queue.length; q++) {
    const r = queue[q] ?? 0;
    for (const n of adj[r] ?? []) {
      if (hops[n] !== -1) continue;
      hops[n] = (hops[r] ?? 0) + 1;
      queue.push(n);
    }
  }
  const order = infos.map((_, k) => k);
  const rank = (k: number) => (hops[k] === -1 ? Number.MAX_SAFE_INTEGER : (hops[k] ?? 0));
  order.sort((a, b) => rank(a) - rank(b) || ((infos[a]?.id ?? "") < (infos[b]?.id ?? "") ? -1 : 1));
  const listed = order.slice(0, cfg.maxRegions);
  const listedIds = new Set(listed.map((k) => infos[k]?.id ?? ""));

  const regions = listed.map((k) => {
    const r = infos[k];
    if (!r) throw new Error("region index");
    const wp = topo.waypoint(k);
    return {
      id: r.id,
      knownPct: pct(r.known, r.cells),
      freePct: pct(r.free, r.known),
      zones: r.zones,
      waypoint: wp === undefined ? null : { id: `w-${r.id}`, xM: g.cellCenterX(wp % g.sizeX), yM: g.cellCenterY((wp / g.sizeX) | 0) },
      edges: edges
        .filter((e) => (e.a === r.id && listedIds.has(e.b)) || (e.b === r.id && listedIds.has(e.a)))
        .map((e) => ({ to: e.a === r.id ? e.b : e.a, cls: e.cls })),
    };
  });

  const groups = topo.frontierGroups();
  const unmarked = groups.filter((f) => !isMarked(f));
  const withD = unmarked.map((f) => {
    const xM = g.cellCenterX(f.point % g.sizeX);
    const yM = g.cellCenterY((f.point / g.sizeX) | 0);
    const dx = xM - agent.xM;
    const dy = yM - agent.yM;
    return { f, xM, yM, dx, dy, d2: dx * dx + dy * dy };
  });
  withD.sort((a, b) => a.d2 - b.d2 || (a.f.id < b.f.id ? -1 : a.f.id > b.f.id ? 1 : 0));
  const frontiers = withD.slice(0, cfg.maxFrontiers).map((x) => ({
    id: x.f.id,
    region: x.f.region,
    cells: x.f.cells.length,
    boundaryM: Math.round(x.f.cells.length * res),
    xM: x.xM,
    yM: x.yM,
    distanceM: Math.round(Math.sqrt(x.d2)),
    octant: octantOf(x.dx, x.dy),
  }));

  const ownInfo = infos[own];
  return {
    abstraction: cfg.abstraction,
    region: ownInfo?.id ?? "",
    inRegionM: { x: Math.round(agent.xM - (ownInfo?.i0 ?? 0) * res), y: Math.round(agent.yM - (ownInfo?.j0 ?? 0) * res) },
    regions,
    frontiers,
    omitted: { regions: infos.length - listed.length, frontiers: unmarked.length - frontiers.length, markedFrontiers: groups.length - unmarked.length },
  };
}
