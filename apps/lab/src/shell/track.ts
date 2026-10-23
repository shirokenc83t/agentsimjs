/** Where things sit on the player's scrub track, as percentages of its width (pure, so the player and its tests agree). */
export interface TrackLayout {
  /** The span the track stands for, in seconds: the newest of the sim head, the saved head and one tick. */
  readonly scaleS: number;
  readonly savedPct: number;
  /** The gap between what is saved and the sim head ("not saved yet"): where it starts and how wide it is, both 0 when there is none. */
  readonly gapLeftPct: number;
  readonly gapWidthPct: number;
  readonly cursorPct: number;
}

/** `startS` is where the track starts (a re-simulated window starts after 0): positions are measured from it. */
export function trackLayout(a: { readonly headS: number; readonly simHeadS: number | undefined; readonly shownS: number; readonly dtS: number; readonly startS?: number }): TrackLayout {
  const startS = a.startS ?? 0;
  const scaleS = Math.max(a.simHeadS ?? 0, a.headS, startS + a.dtS);
  const pct = (s: number) => (Math.max(0, s - startS) / (scaleS - startS)) * 100;
  const gapS = Math.max(0, (a.simHeadS ?? a.headS) - a.headS);
  return { scaleS, savedPct: pct(a.headS), gapLeftPct: pct(a.headS), gapWidthPct: pct(gapS), cursorPct: pct(a.shownS) };
}
