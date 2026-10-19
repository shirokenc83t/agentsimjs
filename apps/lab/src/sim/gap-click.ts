/**
 * What a click on the Timeline means while a live run is being recorded (ADR-0035 addition of 2026-10-17, item 12): what is on the screen at a moment
 * comes from storage, and storage holds the run up to its persisted head. A click on a moment the storage has resolves to that moment; a click on a
 * moment between the persisted head and the sim head (the gap, "not saved yet") resolves to the persisted head, with a notice, and no query is made for
 * the tick that was clicked: there is nothing stored to ask for. Pure, so the Timeline, the cursor and the tests agree.
 */
export interface GapClick {
  /** The tick the cursor goes to. */
  readonly tick: number;
  /** Set when the click was in the gap (or past the sim head): why the cursor is not where it was clicked. */
  readonly notice?: string;
}

export function resolveGapClick(targetTick: number, persistedHeadTick: number, simHeadTick: number): GapClick {
  const target = Math.max(0, Math.round(targetTick));
  if (target <= persistedHeadTick) return { tick: target };
  const beyond = target > simHeadTick;
  return { tick: persistedHeadTick, notice: `${beyond ? "Past the live run" : "Not saved yet"}: showing the last saved moment, tick ${persistedHeadTick}` };
}

/** The label of the gap on the Timeline: what is between the persisted head and the sim head, in ticks and in sim seconds. */
export function gapLabel(persistedHeadTick: number, simHeadTick: number, dtS: number): string | undefined {
  const ticks = simHeadTick - persistedHeadTick;
  if (ticks <= 0) return undefined;
  return `not saved yet: ${ticks} ticks (${(ticks * dtS).toFixed(1)} s)`;
}
