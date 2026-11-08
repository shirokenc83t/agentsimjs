import type { SimMindsMessage } from "@agentsim/core";

// What the notice, the raise dialog and the chips say of a limit (F4, the designer's LimitsPause): pure functions of the status the worker posts, so the words are tested apart from the screens.

export type LimitName = "calls" | "tokens" | "costUsd";
export type AgentMinds = SimMindsMessage["agents"][number];

/** A number with a thin space between thousands (`40 912`), as the designer's boards write them. */
export const spaced = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Tokens in the tile: `40.9k` from a thousand up, else the number. */
export const kilo = (n: number): string => (n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(Math.round(n)));

export const LIMIT_WORDS: Readonly<Record<LimitName, { readonly short: string; readonly title: string; readonly unit: string }>> = {
  calls: { short: "calls", title: "call limit", unit: "calls" },
  tokens: { short: "tokens", title: "token limit", unit: "tokens" },
  costUsd: { short: "cost", title: "cost limit", unit: "USD" },
};

export const usedOf = (a: AgentMinds, l: LimitName): number => (l === "calls" ? a.calls : l === "tokens" ? a.tokens : a.costUsd);

/** The share of a limit used, in whole percent (0 when it has no limit that applies: a cost without prices). */
export function pctOf(a: AgentMinds, l: LimitName): number {
  if (l === "costUsd" && !a.pricesKnown) return 0;
  const max = a.limits[l];
  return max > 0 ? Math.floor((usedOf(a, l) / max) * 100) : 0;
}

/** The limit closest to its end for an agent, with its share: what the player's tile and the chip show. */
export function worstLimit(a: AgentMinds): { readonly limit: LimitName; readonly pct: number } {
  let best: { limit: LimitName; pct: number } = { limit: "calls", pct: pctOf(a, "calls") };
  for (const l of ["tokens", "costUsd"] as const) {
    const p = pctOf(a, l);
    if (p > best.pct) best = { limit: l, pct: p };
  }
  return best;
}

/** The agent the player's tile follows: the one that paused the run, else the one closest to a limit. */
export function tileAgent(m: SimMindsMessage): AgentMinds | undefined {
  if (m.pausedAt) return m.agents.find((a) => a.agentId === m.pausedAt?.agentId);
  return [...m.agents].sort((a, b) => worstLimit(b).pct - worstLimit(a).pct || (a.agentId < b.agentId ? -1 : 1))[0];
}

/** `used of max (102 %)` in the notice. */
export const usedWords = (used: number, max: number, l: LimitName): string => {
  const fmt = (n: number) => (l === "costUsd" ? n.toFixed(4) : spaced(n));
  return `${fmt(used)} of ${fmt(max)} (${max > 0 ? Math.floor((used / max) * 100) : 0} %)`;
};

/** The presets of the raise dialog: +50 %, ×2 and ×5 of the limit in force (whole numbers; a cost keeps cents). */
export function raisePresets(l: LimitName, max: number): { readonly label: string; readonly value: number }[] {
  const round = (v: number) => (l === "costUsd" ? Math.ceil(v * 100) / 100 : Math.ceil(v));
  return [
    { label: "+50 %", value: round(max * 1.5) },
    { label: "×2", value: round(max * 2) },
    { label: "×5", value: round(max * 5) },
  ];
}

/** What a raise to `value` allows, in words, at the rate the run has had so far. */
export function allowsWords(a: AgentMinds, l: LimitName, value: number): string {
  if (l === "calls") return `${spaced(Math.max(0, value - a.calls))} more calls`;
  if (a.calls === 0) return "no rate yet: no call has been made";
  const perCall = l === "tokens" ? a.tokens / a.calls : a.costUsd / a.calls;
  const used = l === "tokens" ? a.tokens : a.costUsd;
  return perCall > 0 ? `about ${spaced(Math.max(0, (value - used) / perCall))} more calls at the current rate` : "no rate yet";
}

/** The rate of the run so far: `about 2 900 tokens a call`. */
export const rateWords = (a: AgentMinds): string => (a.calls === 0 ? "no call yet" : `about ${spaced(Math.round(a.tokens / a.calls / 100) * 100)} tokens a call`);

/** Whether a typed value is a raise that the dialog may confirm: a number above the limit in force. */
export const validRaise = (value: number, max: number): boolean => Number.isFinite(value) && value > max;
