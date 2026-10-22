/** Geometry of the Timeline canvas (CSS px): the seconds ruler on top, then a lane per agent, the lane names on the left. Shared with the e2e specs that click on it. */
export const RULER_PX = 18;
export const LANE_PX = 19;
export const LABEL_PX = 86;
/** Marks of a lane closer than this (px) are drawn as one with a count. */
export const MERGE_PX = 7;

const STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** The ticks of the seconds ruler: the smallest round step that keeps the labels at least `minGapPx` apart. */
export function rulerTicks(scaleS: number, trackPx: number, minGapPx = 64): { t: number; label: string }[] {
  if (scaleS <= 0 || trackPx <= 0) return [];
  const minStep = (minGapPx / trackPx) * scaleS;
  const step = STEPS_S.find((s) => s >= minStep) ?? STEPS_S[STEPS_S.length - 1] ?? 3600;
  const out: { t: number; label: string }[] = [];
  for (let k = 0; k * step <= scaleS + 1e-9; k++) {
    const t = Math.round(k * step * 1000) / 1000;
    out.push({ t, label: step < 1 ? `${t.toFixed(1)} s` : `${t} s` });
  }
  return out;
}

/** Where on a canvas of this lane count a y (px from its top) falls: the ruler (-1) or the lane. */
export function laneAt(y: number, lanes: number): number {
  if (y < RULER_PX) return -1;
  return Math.min(lanes - 1, Math.floor((y - RULER_PX) / LANE_PX));
}
