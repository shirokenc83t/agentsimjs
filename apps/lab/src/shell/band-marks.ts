import { isFailure, type Mark } from "../panels/debug/marks.ts";

// The marks on the top edge of the swarm knowledge band (ADR-0043 section 7, U-015): a reflex ▲ and a failure ✕ at the sim time they happened, merged when two are closer than 6 px, a click
// selecting the record, a hover telling what is under the glyph.

export interface BandMark {
  /** Where the glyph sits, in px from the start of the strip. */
  readonly x: number;
  /** Sim time of the first mark of the group. */
  readonly t: number;
  /** The first record of the group: what a click selects. */
  readonly seq: number;
  readonly kind: "reflex" | "failure";
  /** How many marks the glyph stands for. */
  readonly count: number;
  /** What a hover says: the marks of the group, a few of them. */
  readonly summary: string;
}

const kindOf = (m: Mark): "reflex" | "failure" | undefined => (isFailure(m) ? "failure" : m.kind === "reflex" ? "reflex" : undefined);

/**
 * The glyphs of the marks over a strip `widthPx` wide that stands for `startS`..`scaleS`: marks of one kind closer than `minGapPx` (6 px) are one glyph with a count; a ▲ and a ✕ never
 * merge, they are told apart by glyph.
 */
export function bandMarks(marks: readonly Mark[], args: { readonly widthPx: number; readonly startS: number; readonly scaleS: number; readonly minGapPx?: number }): BandMark[] {
  const gap = args.minGapPx ?? 6;
  const span = Math.max(1e-9, args.scaleS - args.startS);
  const sorted = marks.filter((m) => kindOf(m) !== undefined).sort((a, b) => a.t - b.t || a.seq - b.seq);
  const groups: { kind: "reflex" | "failure"; x: number; items: Mark[] }[] = [];
  const open: Partial<Record<"reflex" | "failure", { x: number; items: Mark[] }>> = {};
  for (const m of sorted) {
    const kind = kindOf(m) as "reflex" | "failure";
    const x = ((m.t - args.startS) / span) * args.widthPx;
    const g = open[kind];
    if (g !== undefined && x - g.x < gap) g.items.push(m);
    else {
      const next = { x, items: [m] };
      open[kind] = next;
      groups.push({ kind, ...next });
    }
  }
  return groups.map((g) => {
    const first = g.items[0] as Mark;
    const what = g.items.slice(0, 3).map((m) => `${m.agentId ?? "run"} ${m.code ?? (g.kind === "failure" ? "failed" : "reflex")} at ${m.t.toFixed(1)} s`);
    const head = g.items.length === 1 ? "" : `${g.items.length} ${g.kind === "failure" ? "failures" : "reflexes"}: `;
    return { x: g.x, t: first.t, seq: first.seq, kind: g.kind, count: g.items.length, summary: `${head}${what.join(" · ")}${g.items.length > 3 ? ` · +${g.items.length - 3}` : ""}` };
  });
}
