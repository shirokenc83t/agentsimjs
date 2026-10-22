/**
 * Boot settings (ADR-0032, addition of 2026-10-04): the closed list of values kept in `localStorage`, because
 * they are needed before storage opens. This module is the only code that touches `localStorage`; a test
 * fails on any other access. Nothing sensitive, no simulation or run state, no API keys.
 */
export const BOOT_SETTINGS = {
  /** Mirror of the `ui.theme` user setting (source of truth: `user_data`), so the first paint has the right theme. */
  "ui.theme": {
    key: "agentsim.ui.theme",
    why: "First paint happens before storage opens; reading user_data first would flash the wrong theme.",
  },
  /** Minimum quota (bytes) for opening storage persistently on OPFS instead of in memory. */
  "storage.quotaThreshold": {
    key: "agentsim.quotaThresholdBytes",
    why: "It decides how storage is opened, so it must be readable before storage (and user_data) exists.",
  },
  /** No motion at all (on top of the OS preference): a UI convenience read at first paint. */
  "ui.reducedMotion": {
    key: "agentsim.ui.reducedMotion",
    why: "It must hold from the first paint, before storage opens, so no transition plays that the viewer asked not to see.",
  },
  /** The dot grid of the dock area, on or off. */
  "ui.dockGrid": {
    key: "agentsim.ui.dockGrid",
    why: "The dock is drawn at first paint, before storage opens; the grid must not flash on and off.",
  },
} as const;

export type BootSetting = keyof typeof BOOT_SETTINGS;

/** The setting's raw value, or undefined if missing or storage is unavailable (private mode, blocked). */
export function readBootSetting(name: BootSetting): string | undefined {
  try {
    return globalThis.localStorage?.getItem(BOOT_SETTINGS[name].key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeBootSetting(name: BootSetting, value: string): void {
  try {
    globalThis.localStorage?.setItem(BOOT_SETTINGS[name].key, value);
  } catch {
    // Blocked or full: boot settings are conveniences; their defaults apply.
  }
}
