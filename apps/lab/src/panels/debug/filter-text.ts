import { filterTokens } from "@agentsim/trace";

// The quick toggles of the log console write into the filter text (UI-SPEC §5.1: "quick toggles per kind/tier"): the text is the one state, so what a toggle shows is what
// a filter typed by hand would be. These helpers read and rewrite one positive `key:a,b` term of a filter, leaving every other term, and the spacing around it, as typed.

/** The values of the first positive `key:` term of the filter, or undefined when it has none. */
export function termValues(text: string, key: string): string[] | undefined {
  for (const t of filterTokens(text)) {
    if (t.text.startsWith(`${key}:`)) return t.text.slice(key.length + 1).split(",");
  }
  return undefined;
}

/**
 * The filter with its `key:` term set to `values`: replaced in place, appended when there was none, removed when `values` is empty or undefined. A second `key:` term (the
 * first one is the one the toggles own) is left as typed.
 */
export function withTermValues(text: string, key: string, values: readonly string[] | undefined): string {
  const tokens = filterTokens(text);
  const at = tokens.findIndex((t) => t.text.startsWith(`${key}:`));
  const term = values === undefined || values.length === 0 ? undefined : `${key}:${values.join(",")}`;
  if (at < 0) return term === undefined ? text : `${text.trimEnd()}${text.trim() === "" ? "" : " "}${term}`;
  const t = tokens[at] as { text: string; at: number };
  const before = text.slice(0, t.at);
  const after = text.slice(t.at + t.text.length);
  if (term !== undefined) return `${before}${term}${after}`;
  // Removing: the spacing that separated it goes with it.
  return `${before.trimEnd()}${before.trimEnd() === "" ? after.trimStart() : after.startsWith(" ") || after === "" ? after : ` ${after}`}`.trim();
}

/**
 * The toggle of one choice in a set of choices written as a `key:` term (kinds, tiers): the choices shown are the term's values, or all of them when there is no term.
 * A plain click flips one; `solo` shows only that one, or all again when it was already the only one. Every choice shown (and every choice off) is no term at all.
 */
export function toggleChoice(text: string, key: string, choice: string, all: readonly string[], solo: boolean): string {
  const shown = termValues(text, key) ?? [...all];
  let next: string[];
  if (solo) next = shown.length === 1 && shown[0] === choice ? [...all] : [choice];
  else next = shown.includes(choice) ? shown.filter((x) => x !== choice) : all.filter((x) => x === choice || shown.includes(x));
  // Every choice off is no filter at all, not an empty console.
  if (next.length === 0) next = [...all];
  return withTermValues(text, key, next.length === all.length ? undefined : next);
}

/** The choices of `all` that the filter shows for `key`: the term's values, or every one when it has no term. */
export function shownChoices(text: string, key: string, all: readonly string[]): ReadonlySet<string> {
  const v = termValues(text, key);
  return new Set(v === undefined ? all : all.filter((x) => v.includes(x)));
}
