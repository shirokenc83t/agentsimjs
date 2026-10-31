import type { EffectiveS2, PromptTemplateDocument } from "@agentsim/minds";
import type { RunConfigDocument } from "@agentsim/scenarios";

// The model of the `minds` table of the run configuration (F4 M4, T-125, the designer's LibraryMinds board): which agents have a language-model mind (`s2`), the entry of an agent as the form writes it, and the
// estimate of what a run will cost in calls and tokens against the limits, as a range and labelled as an estimate. Pure: the panel only draws it.

export const MISSION_MAX_CHARS = 2000;

type S2Entry = NonNullable<NonNullable<NonNullable<RunConfigDocument["minds"]>["byAgent"]>[string]["s2"]>;
export type MindsRunMode = "live" | "replay-strict" | "replay-then-live";
export const RUN_MODES: readonly { readonly mode: MindsRunMode; readonly words: string }[] = [
  { mode: "live", words: "calls the provider; answers are cached" },
  { mode: "replay-strict", words: "cache only, 0 calls; stops on a miss" },
  { mode: "replay-then-live", words: "cache first, live on a miss; marks the run \"not reproducible\"" },
];

/** The `s2` entry the run configuration gives this agent by name, or undefined (an `s1` mission or nothing). */
export const s2Of = (doc: RunConfigDocument, key: string): S2Entry | undefined => doc.minds?.byAgent?.[key]?.s2;

/** The run configuration with this agent's `s2` entry set; `undefined` takes the agent's mind away. An empty `minds` section is dropped. */
export function withS2(doc: RunConfigDocument, key: string, entry: S2Entry | undefined): RunConfigDocument {
  const byAgent = { ...doc.minds?.byAgent };
  if (entry === undefined) delete byAgent[key];
  else byAgent[key] = { s2: entry };
  const minds = { ...doc.minds, byAgent } as NonNullable<RunConfigDocument["minds"]>;
  if (Object.keys(byAgent).length === 0) delete (minds as { byAgent?: unknown }).byAgent;
  const { minds: _old, ...rest } = doc;
  return Object.keys(minds).length === 0 ? (rest as RunConfigDocument) : ({ ...rest, minds } as RunConfigDocument);
}

/** The run configuration with its run mode for the minds set (`live` is the default and is written by omission, so a run that never named one keeps its document). */
export function withRunMode(doc: RunConfigDocument, mode: MindsRunMode): RunConfigDocument {
  const { mindsRunMode: _old, ...rest } = doc;
  return mode === "live" ? (rest as RunConfigDocument) : ({ ...rest, mindsRunMode: mode } as RunConfigDocument);
}

export const runModeOf = (doc: RunConfigDocument): MindsRunMode => (doc.mindsRunMode ?? "live") as MindsRunMode;

// ---- the estimate ----------------------------------------------------------------------------------------------------------------------------------

/** The places a mission names: coordinate pairs `(20, 40)`, and the base when it says to return or to land. */
export function missionPoints(mission: string): number {
  const pairs = mission.match(/\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/g)?.length ?? 0;
  const base = /\b(base|home|return|land)\b/i.test(mission) ? 1 : 0;
  return pairs + base;
}

/** What a request carries besides the template and the mission (self, beliefs, space, events, the allowed actions): a typical size, in tokens. */
export const REQUEST_TOKENS = 1800;

export interface Estimate {
  readonly points: number;
  /** Calls the run is expected to make: a range, 2 to 4 for each point of the mission, and one to finish. */
  readonly calls: readonly [number, number];
  readonly tokens: readonly [number, number];
  /** Tokens of one call (the template, the mission and a typical request). */
  readonly perCallTokens: number;
  readonly costUsd: readonly [number, number] | undefined;
  /** The limits the estimate is set against (the effective ones). */
  readonly limits: { readonly calls: number; readonly tokens: number; readonly costUsd: number };
}

/** The estimate for one agent: from the mission's points, 2 to 4 calls for each and one to finish, at the size of the prompt (the template, the mission and a typical request). A range, not a promise. */
export function estimate(args: { readonly mission: string; readonly effective: Pick<EffectiveS2, "limits">; readonly template: PromptTemplateDocument; readonly prices?: { readonly inputUsdPerMTok: number; readonly outputUsdPerMTok: number } | undefined }): Estimate {
  const points = missionPoints(args.mission);
  const templateChars = args.template.system.length + Object.values(args.template.instructions ?? {}).reduce((n, t) => n + t.length, 0);
  const perCall = Math.ceil(templateChars / 4) + Math.ceil(args.mission.length / 4) + REQUEST_TOKENS;
  const calls: [number, number] = [2 * points + 1, 4 * points + 1];
  const tokens: [number, number] = [calls[0] * perCall, calls[1] * perCall];
  const p = args.prices;
  // The answer is short next to the prompt: 5 % of the input is a fair size for the output of the call.
  const cost = (t: number) => (p === undefined ? 0 : (t * p.inputUsdPerMTok + t * 0.05 * p.outputUsdPerMTok) / 1e6);
  return { points, calls, tokens, perCallTokens: perCall, costUsd: p === undefined ? undefined : [cost(tokens[0]), cost(tokens[1])], limits: { calls: args.effective.limits.calls, tokens: args.effective.limits.tokens, costUsd: args.effective.limits.costUsd } };
}

const kilo = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** The estimate in the words of the board: `9–17 of 20`, `26k–51k of 60k`, `no prices`. */
export function estimateWords(e: Estimate): { readonly calls: string; readonly tokens: string; readonly cost: string; readonly basis: string; readonly overLimit: boolean } {
  return {
    calls: `${e.calls[0]}–${e.calls[1]} of ${e.limits.calls}`,
    tokens: `${kilo(e.tokens[0])}–${kilo(e.tokens[1])} of ${kilo(e.limits.tokens)}`,
    cost: e.costUsd === undefined ? "no prices" : `${e.costUsd[0].toFixed(4)}–${e.costUsd[1].toFixed(4)} of ${e.limits.costUsd.toFixed(2)} USD`,
    basis: `From the mission's points (${e.points}), 2–4 calls per point and one to finish, and the size of the prompt (about ${kilo(e.perCallTokens)} tok a call). It is a range, not a promise; the run pauses at a limit.`,
    overLimit: e.calls[1] > e.limits.calls || e.tokens[1] > e.limits.tokens || (e.costUsd !== undefined && e.costUsd[1] > e.limits.costUsd),
  };
}
