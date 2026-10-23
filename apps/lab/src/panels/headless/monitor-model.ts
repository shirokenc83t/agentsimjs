import type { SimProgressMessage } from "@agentsim/core";

// The numbers of the headless run monitor (ADR-0029, ADR-0035 section 7): pure functions of the worker's progress message, so they are the same for the same message
// whatever the clock of the page says (the wall time is the worker's own, in the message).

export type Progress = SimProgressMessage;

/** The fields a number is computed from, with the end condition allowed to be absent (written or not). */
type From<K extends keyof Progress> = Omit<Pick<Progress, K>, "untilS"> & { readonly untilS?: number | undefined };

/** How far the run is towards its end condition, 0 to 1; none for a run that has none. */
export function fractionDone(p: From<"simTimeS" | "done">): number | undefined {
  if (p.untilS === undefined || p.untilS <= 0) return undefined;
  return p.done && p.simTimeS >= p.untilS - 1e-6 ? 1 : Math.max(0, Math.min(1, p.simTimeS / p.untilS));
}

/** The estimated wall time left, in seconds: the sim time left at the speed of the last window. None without an end condition, when it is over, or when it does not move. */
export function etaS(p: From<"simTimeS" | "simSecondsPerSecond" | "done" | "running">): number | undefined {
  if (p.untilS === undefined || p.done || !p.running || !(p.simSecondsPerSecond > 0)) return undefined;
  return Math.max(0, (p.untilS - p.simTimeS) / p.simSecondsPerSecond);
}

/** `12.3 s`, `3 min 05 s`, `1 h 02 min`. */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.round(s - m * 60)).padStart(2, "0")} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m - h * 60).padStart(2, "0")} min`;
}

/** Thousands separated by a thin space, so a tick count of a long run stays readable. */
export const grouped = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** The speed against real time: `×48 real time` for 48 sim seconds per wall second. */
export function speedLabel(simSecondsPerSecond: number): string {
  if (!(simSecondsPerSecond > 0)) return "—";
  return `×${simSecondsPerSecond >= 10 ? Math.round(simSecondsPerSecond) : simSecondsPerSecond.toFixed(1)} real time`;
}

/** What the run is waiting for, in words (nothing: it is stepping). */
export function waitingLabel(w: Progress["waiting"], running: boolean, done: boolean): string {
  if (done) return "done";
  if (!running) return "paused";
  switch (w) {
    case "none":
      return "stepping, not waiting for anything";
    case "decision":
      return "waiting for a mind's decision (lockstep: the sim clock stops)";
    case "header":
      return "waiting for the storage worker to have the run header";
    case "storage_backpressure":
      return "waiting for the writer: the backlog is above its high mark (wall time only, nothing is lost)";
    case "storage_quota":
      return "paused: the storage quota is near its limit";
    default:
      return "waiting";
  }
}

/** The volume of what the run has stored: per sim hour at the pace so far, and at its end condition when it has one. Undefined until there is something to extrapolate from. */
export function estimateVolume(storedBytes: number | undefined, simTimeS: number, untilS: number | undefined): { readonly perSimHourBytes: number; readonly atEndBytes: number | undefined } | undefined {
  if (storedBytes === undefined || !(simTimeS >= 1) || storedBytes <= 0) return undefined;
  const perS = storedBytes / simTimeS;
  return { perSimHourBytes: perS * 3600, atEndBytes: untilS === undefined ? undefined : perS * untilS };
}

/** The positions (0 to 1) of the snapshot marks along the progress bar: against the end condition, or, for a run without one, against the sim time so far. */
export function snapshotMarks(p: From<"snapshotTicks" | "simTimeS" | "tick">, dtS: number): number[] {
  const span = p.untilS ?? Math.max(p.simTimeS, dtS);
  if (!(span > 0)) return [];
  return p.snapshotTicks.map((t) => Math.max(0, Math.min(1, (t * dtS) / span)));
}

/** A polyline of at most `maxPoints` points for a sparkline `w` × `h` px: the series thinned evenly (the last point always kept), scaled to its own range. Empty for fewer than two points. */
export function sparkPoints(points: readonly { readonly t: number; readonly v: number }[], w: number, h: number, maxPoints = 120): string {
  if (points.length < 2) return "";
  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  const thin: { readonly t: number; readonly v: number }[] = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const t0 = (thin[0] as { t: number; v: number }).t;
  const t1 = (thin[thin.length - 1] as { t: number; v: number }).t;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of thin) {
    lo = Math.min(lo, p.v);
    hi = Math.max(hi, p.v);
  }
  const span = hi - lo < 1e-12 ? 1 : hi - lo;
  const dt = t1 - t0 < 1e-12 ? 1 : t1 - t0;
  return thin.map((p) => `${(((p.t - t0) / dt) * w).toFixed(1)},${(h - 1 - ((p.v - lo) / span) * (h - 2)).toFixed(1)}`).join(" ");
}
