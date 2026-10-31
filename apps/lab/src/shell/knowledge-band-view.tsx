import { useUiContext } from "@agentsim/ui";
import { useEffect, useRef, useState } from "react";
import type { Mark } from "../panels/debug/marks.ts";
import { bandMarks } from "./band-marks.ts";
import { knowledgeAt, knowledgeShown, knowledgeWords, type KnowledgeBand } from "./knowledge-band.ts";

const W = 1000;
const H = 100;

/**
 * A step line (a sample holds until the next one, nothing is interpolated) as a closed area under `pick`, split where the band has a gap: the value is not carried across a span with no
 * sample. `base` makes the area start from another curve (the matching share) instead of the floor: what lies between the two is the disagreement.
 */
function area(band: KnowledgeBand, x: (t: number) => number, top: (p: { knownPct: number; matchPct: number }) => number, base?: (p: { knownPct: number; matchPct: number }) => number): string {
  let d = "";
  const runs: { t: number; hi: number; lo: number }[][] = [];
  let run: { t: number; hi: number; lo: number }[] = [];
  let prevT: number | undefined;
  for (const p of band.points) {
    if (prevT !== undefined && band.gaps.some((g) => g.fromS === prevT && g.toS === p.t)) {
      runs.push(run);
      run = [];
    }
    run.push({ t: p.t, hi: top(p), lo: base ? base(p) : 0 });
    prevT = p.t;
  }
  if (run.length > 0) runs.push(run);
  for (const r of runs) {
    const endT = (r.at(-1)?.t ?? 0) + (band.everyS ?? 0) / Math.max(1, band.observed);
    const up = [`M${x((r[0] as { t: number }).t).toFixed(1)} ${(H - (r[0] as { hi: number }).hi).toFixed(1)}`];
    for (let i = 1; i < r.length; i++) up.push(`L${x((r[i] as { t: number }).t).toFixed(1)} ${(H - (r[i - 1] as { hi: number }).hi).toFixed(1)}L${x((r[i] as { t: number }).t).toFixed(1)} ${(H - (r[i] as { hi: number }).hi).toFixed(1)}`);
    up.push(`L${x(endT).toFixed(1)} ${(H - (r.at(-1) as { hi: number }).hi).toFixed(1)}`);
    const down = [`L${x(endT).toFixed(1)} ${(H - (r.at(-1) as { lo: number }).lo).toFixed(1)}`];
    for (let i = r.length - 1; i >= 1; i--) down.push(`L${x((r[i] as { t: number }).t).toFixed(1)} ${(H - (r[i - 1] as { lo: number }).lo).toFixed(1)}L${x((r[i] as { t: number }).t).toFixed(1)} ${(H - (r[i] as { lo: number }).lo).toFixed(1)}`);
    down.push(`L${x((r[0] as { t: number }).t).toFixed(1)} ${(H - (r[0] as { lo: number }).lo).toFixed(1)}Z`);
    d += `${up.join("")}${down.join("")}`;
  }
  return d;
}

/** The top line of the known area: the same steps, as a line. */
function topLine(band: KnowledgeBand, x: (t: number) => number): string {
  let d = "";
  let prev: { t: number; v: number } | undefined;
  for (const p of band.points) {
    const gap = prev !== undefined && band.gaps.some((g) => g.fromS === prev?.t && g.toS === p.t);
    const y = (H - p.knownPct).toFixed(1);
    if (prev === undefined || gap) d += `M${x(p.t).toFixed(1)} ${y}`;
    else d += `L${x(p.t).toFixed(1)} ${(H - prev.v).toFixed(1)}L${x(p.t).toFixed(1)} ${y}`;
    prev = { t: p.t, v: p.knownPct };
  }
  return d;
}

/** The width of an element in px, kept up to date (a default where there is no layout, as in a test). */
function useWidth(ref: React.RefObject<HTMLElement | null>, fallback = 600): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const read = () => setW(el.getBoundingClientRect().width || fallback);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}

/**
 * The swarm knowledge strip of the player (ADR-0043 section 7, U-015): 22 px on the well, a fixed 0–100 % scale with a rule at 50 %. The known share is an area in `fg3` with a 1 px `fg2` top
 * line; the part of it that does not match the truth is a band in the warning colour; the time before the first sample and every span with no sample are the hatch; a run with no belief samples
 * at all is hatched whole. ▲ reflex and ✕ failure marks sit on the top edge (merged under 6 px, a click selects the record, a hover says what is under it). Observer data: labelled so.
 */
export function KnowledgeStrip(props: { band: KnowledgeBand; marks: readonly Mark[]; runId: string | undefined; startS: number; scaleS: number; atS: number }) {
  const { startS, scaleS } = props;
  const original = props.band;
  // Where the union of the agents' known cells has been computed the strip draws it (the matching part scaled from the samples); else the mean over the agents.
  const band: KnowledgeBand = original.union === undefined ? original : { ...original, points: unionPoints(original), gaps: unionGaps(original), everyS: (original.union.stepS ?? 0) * Math.max(1, original.observed) };
  const host = useRef<HTMLDivElement>(null);
  const widthPx = useWidth(host);
  const span = Math.max(1e-9, scaleS - startS);
  const x = (t: number) => (Math.max(0, t - startS) / span) * W;
  const pct = (t: number) => `${(Math.max(0, t - startS) / span) * 100}%`;
  const words = knowledgeWords(original, props.atS);
  const at = knowledgeShown(original, props.atS);
  const first = original.points[0];
  const marks = bandMarks(props.marks, { widthPx, startS, scaleS });
  const empty = original.points.length === 0;
  return (
    <div className="kbs" ref={host} data-testid="player-knowledge-band" data-known={at?.knownPct} data-match={at?.matchPct} data-kind={at?.kind} data-union-ms={original.union?.costMs} data-union-reads={original.union?.calls} data-points={original.points.length} data-empty={empty ? "true" : undefined} role="img" aria-label={words} title={words}>
      {empty && <div className="kb-hatch" style={{ left: 0, right: 0 }} data-testid="player-knowledge-nosamples" title="No belief samples in this recording profile: nothing to draw" />}
      {!empty && first !== undefined && first.t > startS && <div className="kb-hatch" style={{ left: 0, width: pct(first.t) }} data-testid="player-knowledge-before" title={`Before the first sample (${first.t.toFixed(1)} s): nothing known yet`} />}
      {original.gaps.map((g) => (
        <div key={g.fromS} className="kb-hatch" style={{ left: pct(g.fromS + (original.everyS ?? 0)), width: `${((g.toS - g.fromS - (original.everyS ?? 0)) / span) * 100}%` }} data-testid="player-knowledge-gap" title={`No sample from ${g.fromS.toFixed(1)} s to ${g.toS.toFixed(1)} s: the value is not carried across`} />
      ))}
      {!empty && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <line className="kb-rule" x1={0} x2={W} y1={H / 2} y2={H / 2} vectorEffect="non-scaling-stroke" />
          <path className="kb-known" d={area(band, x, (p) => p.knownPct)} />
          <path className="kb-warn" d={area(band, x, (p) => p.knownPct, (p) => p.matchPct)} data-testid="player-knowledge-disagree" />
          <path className="kb-top" d={topLine(band, x)} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {marks.map((m) => (
        <button
          key={`${m.kind}-${m.seq}`}
          type="button"
          className={`kb-mark ${m.kind}`}
          data-testid="player-flag"
          data-flag={m.kind}
          style={{ left: m.x }}
          title={m.summary}
          aria-label={m.summary}
          onClick={(e) => {
            e.stopPropagation();
            if (props.runId !== undefined) useUiContext.getState().selectRecord({ runId: props.runId, seq: m.seq });
          }}
        >
          <svg viewBox="0 0 9 9" width="9" height="9" aria-hidden="true">
            {m.kind === "failure" ? <path d="M1 1 L8 8 M8 1 L1 8" /> : m.kind === "raise" ? <path d="M4.5 0.8 L8.2 4.5 L4.5 8.2 L0.8 4.5 Z" /> : <path d="M4.5 1 L8.2 8 L0.8 8 Z" />}
          </svg>
        </button>
      ))}
    </div>
  );
}

/** The band's points with the union of the known cells for the known share, at the times the union was taken; the matching share is the samples' share of what is known, applied to it. */
function unionPoints(band: KnowledgeBand): KnowledgeBand["points"] {
  return (band.union?.points ?? []).map((u) => {
    const shown = knowledgeShown({ ...band, union: { ...(band.union as NonNullable<KnowledgeBand["union"]>), points: [u] } }, u.t);
    const mean = knowledgeAt(band, u.t);
    return { t: u.t, knownPct: shown?.knownPct ?? u.pct, matchPct: shown?.matchPct ?? 0, agents: mean?.agents ?? band.observed };
  });
}

/** The gaps of the union's points: the spans where the union was not taken for more than two steps (the mean's own gaps hatch separately). */
function unionGaps(band: KnowledgeBand): KnowledgeBand["gaps"] {
  const pts = band.union?.points ?? [];
  const step = band.union?.stepS ?? 0;
  const out: { fromS: number; toS: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { t: number };
    const b = pts[i] as { t: number };
    if (b.t - a.t > 2 * step) out.push({ fromS: a.t, toS: b.t });
  }
  return out;
}
