/**
 * What the status bar says of rendering: published by the Scene while it is mounted (it owns the renderer and its frame timers), read at the panel poll rate.
 * Undefined when no Scene is on screen.
 */
export interface FrameStats {
  readonly fps: number;
  readonly workMeanMs: number;
  readonly workP95Ms: number;
}

let latest: FrameStats | undefined;

export function publishFrameStats(s: FrameStats | undefined): void {
  latest = s;
}

export function getFrameStats(): FrameStats | undefined {
  return latest;
}
