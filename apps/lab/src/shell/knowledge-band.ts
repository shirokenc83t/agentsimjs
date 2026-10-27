import type { TraceRecord } from "@agentsim/trace";

// The swarm knowledge band (ADR-0043 section 7), derived from the observer's recorded `belief-vs-truth` samples and nothing else. Each sample says, for one agent at one time, what share of
// the cells it can reach it knows nothing about (`unknownPct`) and what share it believes free that is free (`correctPct`); an `ideal` agent has no belief to compare and no sample of that
// kind. Observer data: never an input of a mind, and shown labelled as such.

export interface KnowledgePoint {
  /** Sim time of the sample that made this point. */
  readonly t: number;
  /** Mean over the agents that have reported, of the share of their reachable cells they know something about (100 minus unknown). */
  readonly knownPct: number;
  /** Mean over the same agents, of the share of their reachable cells they believe free and that are free: how much of what they know matches the truth. */
  readonly matchPct: number;
  /** Agents that have reported by now (each counted once, with its latest sample). */
  readonly agents: number;
}

export interface KnowledgeBand {
  readonly points: readonly KnowledgePoint[];
  /** Agents with a belief to compare (a sample with a map): the denominator the band is a mean over once all have reported. */
  readonly observed: number;
  /** Agents that plan on the ground truth (`ideal`): they have no belief to compare and are not in the mean. */
  readonly ideal: number;
  /** The time between two samples of one agent (the median of the spacings), or undefined before any agent has two. */
  readonly everyS: number | undefined;
  /** Spans longer than two sampling intervals with no sample: the band says "not sampled" there (a hatch), it does not carry the last value across. */
  readonly gaps: readonly { readonly fromS: number; readonly toS: number }[];
}

interface Sample {
  readonly t: number;
  readonly agentId: string;
  readonly known?: number;
  readonly match?: number;
  readonly ideal: boolean;
}

/** The samples of a list of records, in time order (records of any other kind or op are ignored). */
function samplesOf(records: readonly TraceRecord[]): Sample[] {
  const out: Sample[] = [];
  for (const r of records) {
    const p = r.payload as { op?: unknown; ideal?: unknown; map?: { unknownPct?: unknown; correctPct?: unknown } } | undefined;
    if (r.agentId === undefined || p?.op !== "belief-vs-truth") continue;
    if (p.ideal === true) out.push({ t: r.simTime, agentId: r.agentId, ideal: true });
    else if (typeof p.map?.unknownPct === "number" && typeof p.map.correctPct === "number") out.push({ t: r.simTime, agentId: r.agentId, known: 100 - p.map.unknownPct, match: p.map.correctPct, ideal: false });
  }
  return out.sort((a, b) => a.t - b.t);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The band over time. Its definition, exactly: at each sample of an agent that has a map, the point holds the mean of every agent's latest sample so far, of the known share and of the
 * matching share; agents that have not reported yet are not in the mean (the point says how many are). Percentages are of each agent's own reachable cells, so the mean is of agents, not of
 * cells, and an area two agents both know counts twice: the union of what the swarm knows needs the cells, and the recording holds shares, not cells.
 */
export function knowledgeBand(records: readonly TraceRecord[]): KnowledgeBand {
  const samples = samplesOf(records);
  const latest = new Map<string, { known: number; match: number }>();
  const lastT = new Map<string, number>();
  const spacings: number[] = [];
  const ideal = new Set<string>();
  const points: KnowledgePoint[] = [];
  for (const s of samples) {
    if (s.ideal) {
      ideal.add(s.agentId);
      continue;
    }
    const before = lastT.get(s.agentId);
    if (before !== undefined && s.t > before) spacings.push(s.t - before);
    lastT.set(s.agentId, s.t);
    latest.set(s.agentId, { known: s.known as number, match: s.match as number });
    let k = 0;
    let m = 0;
    for (const v of latest.values()) {
      k += v.known;
      m += v.match;
    }
    const n = latest.size;
    const point: KnowledgePoint = { t: s.t, knownPct: round2(k / n), matchPct: round2(m / n), agents: n };
    // Several agents sampled at one instant make one point: the last one carries all of them.
    if (points.at(-1)?.t === s.t) points[points.length - 1] = point;
    else points.push(point);
  }
  spacings.sort((a, b) => a - b);
  const everyS = spacings.length === 0 ? undefined : (spacings[Math.floor(spacings.length / 2)] as number);
  const gaps: { fromS: number; toS: number }[] = [];
  if (everyS !== undefined) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as KnowledgePoint;
      const b = points[i] as KnowledgePoint;
      if (b.t - a.t > 2 * everyS) gaps.push({ fromS: a.t, toS: b.t });
    }
  }
  return { points, observed: latest.size, ideal: ideal.size, everyS, gaps };
}

/** The band at time `t`: the latest point at or before it, if any. */
export function knowledgeAt(band: KnowledgeBand, t: number): KnowledgePoint | undefined {
  let found: KnowledgePoint | undefined;
  for (const p of band.points) {
    if (p.t > t + 1e-9) break;
    found = p;
  }
  return found;
}

/** What the band says in words, for its label and tooltip: observer data, the latest values, how many agents, and its rate. */
export function knowledgeWords(band: KnowledgeBand, t: number): string {
  const p = knowledgeAt(band, t);
  if (p === undefined) return band.ideal > 0 && band.observed === 0 ? "swarm knowledge · observer data · every agent plans on the ground truth: nothing to compare" : "swarm knowledge · observer data · no sample yet";
  const rate = band.everyS === undefined ? "" : ` · each agent every ${Math.round(band.everyS * 2) / 2} s`;
  const agents = p.agents < band.observed ? `the ${p.agents} of ${band.observed} agents that have reported` : `${p.agents} agent${p.agents === 1 ? "" : "s"}`;
  return `swarm knowledge · observer data · agents know ${p.knownPct.toFixed(1)} % of what they can reach on average, ${p.matchPct.toFixed(1)} % matching the truth · mean of ${agents}${band.ideal > 0 ? ` (${band.ideal} ideal not counted)` : ""}${rate}`;
}
