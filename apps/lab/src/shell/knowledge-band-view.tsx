import { knowledgeAt, knowledgeWords, type KnowledgeBand } from "./knowledge-band.ts";

const W = 1000;
const H = 100;

/** A step line (a sample holds until the next one) over `points`, split where a gap is: one path of the known area, one of the matching area, one line along the top of the known. */
function paths(band: KnowledgeBand, x: (t: number) => number, pick: (p: { knownPct: number; matchPct: number }) => number): string {
  let d = "";
  let open = false;
  let prev: { t: number; v: number } | undefined;
  const close = (t: number) => {
    if (open && prev) d += `L${x(t).toFixed(1)} ${(H - prev.v).toFixed(1)}L${x(t).toFixed(1)} ${H}Z`;
    open = false;
  };
  for (const p of band.points) {
    const gap = prev !== undefined && band.gaps.some((g) => g.fromS === prev?.t && g.toS === p.t);
    if (gap && prev) close(Math.min(p.t, prev.t + (band.everyS ?? 0)));
    const v = pick(p);
    if (!open) {
      d += `M${x(p.t).toFixed(1)} ${H}L${x(p.t).toFixed(1)} ${(H - v).toFixed(1)}`;
      open = true;
    } else if (prev) d += `L${x(p.t).toFixed(1)} ${(H - prev.v).toFixed(1)}L${x(p.t).toFixed(1)} ${(H - v).toFixed(1)}`;
    prev = { t: p.t, v };
  }
  if (prev) close(Math.max(prev.t, band.points.at(-1)?.t ?? 0));
  return d;
}

/**
 * The swarm knowledge band over the player's track (ADR-0043 section 7): what the swarm believes it knows of the map (an area), and inside it how much of that matches the truth (a darker
 * area); what it does not know is the hatch of the track behind, and a span with no sample is left empty. Observer data, labelled so, with the values at the cursor in its accessible name.
 */
export function KnowledgeBandView(props: { band: KnowledgeBand; startS: number; scaleS: number; atS: number }) {
  const { band, startS, scaleS } = props;
  const span = Math.max(1e-9, scaleS - startS);
  const x = (t: number) => (Math.max(0, t - startS) / span) * W;
  const words = knowledgeWords(band, props.atS);
  const at = knowledgeAt(band, props.atS);
  return (
    <svg className="kb" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={words} data-testid="player-knowledge-band" data-known={at?.knownPct} data-match={at?.matchPct} data-points={band.points.length}>
      <title>{words}</title>
      <path className="kb-known" d={paths(band, x, (p) => p.knownPct)} />
      <path className="kb-match" d={paths(band, x, (p) => p.matchPct)} />
    </svg>
  );
}
