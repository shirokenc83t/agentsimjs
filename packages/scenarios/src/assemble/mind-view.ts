import {
  MAX_ENTITY_VIEWS,
  round2,
  type BeliefSummary,
  type EntityView,
  type MindView,
  type MindViewPort,
  type SimAgent,
} from "@agentsim/core";
import { buildSpaceSummary, type PassabilityView } from "@agentsim/spatial";
import type { PlanningServiceAdapter } from "./adapters.ts";
import type { SensingService } from "./sensing.ts";
import { passabilityOf, type TopologyService } from "./topology.ts";

/** Round half up of 100 · a / b, in integers (b > 0). */
function pct(a: number, b: number): number {
  return b <= 0 ? 0 : Math.floor((200 * a + b) / (2 * b));
}

/** A view in which everything is passable: only for agents without a planning configuration (tests). */
const OPEN_VIEW: PassabilityView = { key: "open", passable: () => true };

/**
 * The beliefs and space parts of a decision request (ADR-0005 addition of 2026-10-11), built at a fixed point of the
 * tick from one agent's own entity beliefs, map and planning view: nothing else. This module is what the architecture
 * test instruments: it must read the ground-truth grid zero times for a belief agent.
 */
export class MindViewService implements MindViewPort {
  private readonly byId: ReadonlyMap<string, SimAgent>;

  constructor(
    agents: readonly SimAgent[],
    private readonly sensing: SensingService,
    private readonly topology: TopologyService,
    private readonly planner: PlanningServiceAdapter,
  ) {
    this.byId = new Map(agents.map((a) => [a.id, a]));
  }

  view(agentId: string, simTimeS: number): MindView {
    const agent = this.byId.get(agentId);
    if (!agent) throw new Error(`no mind view for ${agentId}`);
    const topo = this.topology.of(agentId);
    const live = this.planner.liveView(agentId);
    const space = buildSpaceSummary(topo, live ? passabilityOf(live) : OPEN_VIEW, { xM: agent.state.x, yM: agent.state.y }, (f) => this.topology.isMarkedGroup(agentId, f));
    return { beliefs: this.beliefs(agent, simTimeS), space };
  }

  private beliefs(agent: SimAgent, simTimeS: number): BeliefSummary {
    const all: (EntityView & { readonly d2: number })[] = [];
    for (const [id, e] of this.sensing.entities(agent.id)) {
      const dx = e.xM - agent.state.x;
      const dy = e.yM - agent.state.y;
      all.push({ id, kind: e.kind, xM: round2(e.xM), yM: round2(e.yM), zM: round2(e.zM), observedAtS: round2(e.observedAtS), ageS: round2(simTimeS - e.observedAtS), state: e.lost ? "lost" : "detected", d2: dx * dx + dy * dy });
    }
    // Nearest first, ties by ID: a stable order that does not depend on when entities were first seen.
    all.sort((a, b) => a.d2 - b.d2 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let known = 0;
    let free = 0;
    let occupied = 0;
    let cells = 0;
    for (const r of this.topology.of(agent.id).regions()) {
      cells += r.cells;
      known += r.known;
      free += r.free;
      occupied += r.occupied;
    }
    return {
      entities: all.slice(0, MAX_ENTITY_VIEWS).map(({ d2: _d2, ...e }) => e),
      entitiesOmitted: Math.max(0, all.length - MAX_ENTITY_VIEWS),
      map: { knownPct: pct(known, cells), freePct: pct(free, known), occupiedPct: pct(occupied, known) },
    };
  }
}
