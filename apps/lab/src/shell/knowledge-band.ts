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

/** The union of what the agents know, where it has been computed (T-101): the share of the map's cells known to at least one agent, at the times it was taken. */
export interface KnowledgeUnion {
  readonly points: readonly { readonly t: number; readonly pct: number }[];
  /** Seconds between two points. */
  readonly stepS: number;
  /** What it cost: belief maps rebuilt and the wall time spent (diagnostics). */
  readonly calls: number;
  readonly costMs: number;
}

export interface KnowledgeBand {
  readonly points: readonly KnowledgePoint[];
  /** The union of the agents' known cells, when it has been computed for this run: the band shows it instead of the mean. */
  readonly union?: KnowledgeUnion | undefined;
  /** Agents with a belief to compare (a sample with a map): the denominator the band is a mean over once all have reported. */
  readonly observed: number;
  /** Their IDs, in the order they first reported: the maps the union of what they know is taken over. */
  readonly agentIds: readonly string[];
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
  return { points, observed: latest.size, agentIds: [...latest.keys()], ideal: ideal.size, everyS, gaps };
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
  const ideal = band.ideal > 0 ? ` (${band.ideal} ideal not counted)` : "";
  const shown = knowledgeShown(band, t) as NonNullable<ReturnType<typeof knowledgeShown>>;
  if (shown.kind === "union") {
    return `swarm knowledge · observer data · the swarm knows ${shown.knownPct.toFixed(1)} % of the map (the union of what its agents know), and ${shown.matchOfKnownPct.toFixed(1)} % of what it knows matches the truth · ${agents}${ideal}${rate}`;
  }
  return `swarm knowledge · observer data · agents know ${p.knownPct.toFixed(1)} % of what they can reach on average, and ${shown.matchOfKnownPct.toFixed(1)} % of what they know matches the truth · mean of ${agents}${ideal}${rate} · (mean until the first union point: the union of their known cells is not computed here)`;
}

/**
 * The swarm's known share at `t`, in the form the band shows: the union (share of the map's cells known to at least one agent) when it has a point at or before `t`, with the matching share
 * scaled from the samples (the share of what an agent knows that matches the truth, applied to the union); else the mean over the agents. `kind` says which, for the label and the tooltip.
 */
export function knowledgeShown(band: KnowledgeBand, t: number): { readonly kind: "union" | "mean"; readonly knownPct: number; /** The known cells that match the truth, as a share of the map (or of what the agents reach): what the band's disagreement area draws. */ readonly matchPct: number; /** The share of what is known that matches the truth (U-015: matching ÷ known), the number the labels say: "matches 97 %". */ readonly matchOfKnownPct: number } | undefined {
  const mean = knowledgeAt(band, t);
  if (mean === undefined) return undefined;
  let u: { t: number; pct: number } | undefined;
  for (const p of band.union?.points ?? []) {
    if (p.t > t + 1e-9) break;
    u = p;
  }
  if (u === undefined) return { kind: "mean", knownPct: mean.knownPct, matchPct: mean.matchPct, matchOfKnownPct: mean.knownPct > 0 ? Math.round(Math.min(100, (mean.matchPct / mean.knownPct) * 100) * 100) / 100 : 100 };
  const atU = knowledgeAt(band, u.t) ?? mean;
  const ratio = atU.knownPct > 0 ? Math.min(1, atU.matchPct / atU.knownPct) : 1;
  return { kind: "union", knownPct: u.pct, matchPct: Math.round(u.pct * ratio * 100) / 100, matchOfKnownPct: Math.round(ratio * 10000) / 100 };
}
