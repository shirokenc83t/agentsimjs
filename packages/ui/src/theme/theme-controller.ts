import { useSyncExternalStore } from "react";
import { BOOT_SETTINGS, readBootSetting, writeBootSetting } from "../boot-settings.ts";
import type { ThemeName } from "./tokens.ts";

/** The user's choice (Settings); `system` follows `prefers-color-scheme`. */
export type ThemePreference = ThemeName | "system";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["dark", "light", "system"];

/**
 * `localStorage` key of the first-paint mirror of the `ui.theme` user setting (a boot setting, ADR-0032 §2),
 * whose source of truth is `user_data` in storage. Read once at boot, written on change.
 */
export const THEME_MIRROR_KEY = BOOT_SETTINGS["ui.theme"].key;

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "dark" || v === "light" || v === "system";
}

/** Resolved theme: an explicit choice wins; `system` follows the OS preference, dark when unknown. */
export function resolveTheme(p: ThemePreference, prefersLight: boolean | undefined): ThemeName {
  if (p !== "system") return p;
  return prefersLight === true ? "light" : "dark";
}

interface ThemeState {
  readonly preference: ThemePreference;
  readonly resolved: ThemeName;
}

const listeners = new Set<() => void>();
let state: ThemeState = { preference: "system", resolved: "dark" };
let media: MediaQueryList | undefined;

function prefersLight(): boolean | undefined {
  return media ? media.matches : undefined;
}

function apply(next: ThemeState): void {
  state = next;
  document.documentElement.dataset["theme"] = next.resolved;
  document.documentElement.style.colorScheme = next.resolved;
  for (const l of listeners) l();
}

function readMirror(): ThemePreference | undefined {
  const v = readBootSetting("ui.theme");
  return isThemePreference(v) ? v : undefined;
}

function writeMirror(p: ThemePreference): void {
  writeBootSetting("ui.theme", p);
}

/**
 * Applies the theme before first render (no inline script, ADR-0032 §10): the mirror if present, else the
 * OS preference. Call once at boot from the app entry.
 */
export function initTheme(): void {
  media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;
  const preference = readMirror() ?? "system";
  apply({ preference, resolved: resolveTheme(preference, prefersLight()) });
  media?.addEventListener("change", () => {
    if (state.preference === "system") apply({ preference: "system", resolved: resolveTheme("system", prefersLight()) });
  });
}

/** Sets the preference (from Settings, or from `user_data` once storage answers) and refreshes the mirror. */
export function setThemePreference(p: ThemePreference): void {
  writeMirror(p);
  if (p === state.preference) return;
  apply({ preference: p, resolved: resolveTheme(p, prefersLight()) });
}

export function getThemeState(): ThemeState {
  return state;
}

export function subscribeTheme(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Current theme for React components (re-renders only on change). */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribeTheme, getThemeState, getThemeState);
}
