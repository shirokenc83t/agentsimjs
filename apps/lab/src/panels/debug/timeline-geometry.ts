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

/**
 * The range of time a drag on the ruler selects: both ends in px from the canvas's left edge, ordered, clamped to the track and measured in seconds against the span the
 * track stands for. None when the two ends are the same moment.
 */
export function selectionFromDrag(fromPx: number, toPx: number, widthPx: number, scaleS: number): { t0S: number; t1S: number } | undefined {
  const track = widthPx - LABEL_PX;
  if (track <= 0 || scaleS <= 0) return undefined;
  const at = (px: number) => Math.max(0, Math.min(scaleS, ((px - LABEL_PX) / track) * scaleS));
  const a = at(fromPx);
  const b = at(toPx);
  const t0S = Math.round(Math.min(a, b) * 10) / 10;
  const t1S = Math.round(Math.max(a, b) * 10) / 10;
  return t1S > t0S ? { t0S, t1S } : undefined;
}

/** Where on a canvas of this lane count a y (px from its top) falls: the ruler (-1) or the lane. */
export function laneAt(y: number, lanes: number): number {
  if (y < RULER_PX) return -1;
  return Math.min(lanes - 1, Math.floor((y - RULER_PX) / LANE_PX));
}
