
import {
  compileCostProfile,
  type CostProfile,
  parseRunConfigValue,
  resolveRunConfig,
  type BeliefsEntry,
  type DriveEntry,
  type PlanningEntry,
  type ResolvedRunConfig,
  type RunConfigDocument,
  type RunConfigErrorCode,
  type ScenarioAgentsView,
  type StrategyRef,
} from "@agentsim/scenarios";

/**
 * Pure model of the run-configuration form (ADR-0028): which entry is edited (precedence level), immutable
 * updates of the document, and validation through the same parser and resolver the simulator uses. The form
 * edits the canonical document; it never holds a second representation (ADR-0017).
 */

/** The precedence level being edited: `default`, one vehicle kind, or one agent key. */
export type Scope = { readonly level: "default" } | { readonly level: "byKind"; readonly kind: "uav" | "ugv" } | { readonly level: "byAgent"; readonly key: string };

export const scopeId = (s: Scope): string => (s.level === "default" ? "default" : s.level === "byKind" ? `byKind.${s.kind}` : `byAgent.${s.key}`);

export function scopeFromId(id: string): Scope {
  if (id.startsWith("byKind.")) return { level: "byKind", kind: id.slice(7) === "uav" ? "uav" : "ugv" };
  if (id.startsWith("byAgent.")) return { level: "byAgent", key: id.slice(8) };
  return { level: "default" };
}

/** Planning scopes of a scenario: default, both kinds, then every keyed agent (in document order). */
export function planningScopes(view: ScenarioAgentsView): Scope[] {
  const keys = view.agents.flatMap((a) => (a.key === undefined ? [] : [{ level: "byAgent" as const, key: a.key }]));
  return [{ level: "default" }, { level: "byKind", kind: "ugv" }, { level: "byKind", kind: "uav" }, ...keys];
}

/** Drive scopes (ADR-0033: ground vehicles only): default, UGVs, then every keyed UGV. */
export function driveScopes(view: ScenarioAgentsView): Scope[] {
  const keys = view.agents.flatMap((a) => (a.kind === "ugv" && a.key !== undefined ? [{ level: "byAgent" as const, key: a.key }] : []));
  return [{ level: "default" }, { level: "byKind", kind: "ugv" }, ...keys];
}

type Section = "planning" | "drive" | "beliefs";
type EntryOf<S extends Section> = S extends "planning" ? PlanningEntry : S extends "drive" ? DriveEntry : BeliefsEntry;

/**
 * Drops `undefined` fields; `undefined` if nothing remains. One level only: values inside an entry are kept as
 * they are (an empty `weights` is a degenerate profile to report, not "no profile").
 */
function compact<T extends object>(o: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length === 0 ? undefined : (out as T);
}

export function getEntry<S extends Section>(doc: RunConfigDocument, section: S, scope: Scope): EntryOf<S> | undefined {
  const sec = doc[section] as { default?: EntryOf<S>; byKind?: Partial<Record<"uav" | "ugv", EntryOf<S>>>; byAgent?: Record<string, EntryOf<S>> } | undefined;
  if (!sec) return undefined;
  if (scope.level === "default") return sec.default;
  if (scope.level === "byKind") return sec.byKind?.[scope.kind];
  return sec.byAgent?.[scope.key];
}

/** Returns a new document with the entry of `scope` replaced (`undefined` removes it); empty sections are dropped. */
export function setEntry<S extends Section>(doc: RunConfigDocument, section: S, scope: Scope, entry: EntryOf<S> | undefined): RunConfigDocument {
  const sec = { ...(doc[section] as Record<string, unknown> | undefined) };
  const clean = entry === undefined ? undefined : compact(entry);
  if (scope.level === "default") sec["default"] = clean;
  else {
    const group = scope.level === "byKind" ? "byKind" : "byAgent";
    const name = scope.level === "byKind" ? scope.kind : scope.key;
    sec[group] = compact({ ...(sec[group] as Record<string, unknown> | undefined), [name]: clean });
  }
  const next: Record<string, unknown> = { ...doc, [section]: compact(sec) };
  if (next[section] === undefined) delete next[section];
  return next as RunConfigDocument;
}

/** Sets one field of an entry (`undefined` = inherit from the lower levels). */
export function withField<E extends object, K extends keyof E>(entry: E | undefined, field: K, value: E[K] | undefined): E {
  const next = { ...entry } as E;
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

export interface ValidationError {
  readonly code: RunConfigErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type Validation = { readonly ok: true; readonly resolved: ResolvedRunConfig } | { readonly ok: false; readonly error: ValidationError };

/**
 * Validates a draft as a run would: schema (`parseRunConfigValue`), then resolution of every agent's effective
 * configuration with the ADR-0028 ranges and the cost-profile compiler. Errors carry their stable codes.
 */
export function validateDraft(doc: unknown, scenario: ScenarioAgentsView, version: number): Validation {
  const parsed = parseRunConfigValue(doc);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const r = resolveRunConfig(parsed.value, { loaded: scenario, version });
  return r.ok ? { ok: true, resolved: r.value } : { ok: false, error: r.error };
}

export interface ProfileIssue {
  readonly code: string;
  readonly message: string;
}

/** Validation of a whole cost profile with its stable codes (ADR-0014, ADR-0026); `undefined` if valid. */
export function profileIssue(p: CostProfile): ProfileIssue | undefined {
  const r = compileCostProfile(p);
  return r.ok ? undefined : { code: r.error.code, message: r.error.message };
}

/**
 * Validation of one constraint on its own, so the form can mark the offending row. The expression is parsed
 * against the whitelisted grammar and variables, never evaluated as code (ADR-0026).
 */
export function constraintIssue(src: string): ProfileIssue | undefined {
  const r = compileCostProfile({ weights: { distance: 1 }, constraints: [src] });
  if (r.ok) return undefined;
  return { code: r.error.code, message: r.error.message.replace(/^constraint 1: /, "") };
}

/** Preset ID from its name (storage requires `^[a-z][a-z0-9-]{0,63}$`); `undefined` if nothing usable remains. */
export function presetIdOf(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : undefined;
}

/**
 * A preset applied to the loaded scenario: presets carry planning and drive settings; the scenario they were
 * saved with is replaced by the current one (the result is validated like any draft, so unknown agent keys
 * are reported with `unknown_agent_key`).
 */
export function rebasePreset(preset: RunConfigDocument, scenario: { readonly id: string; readonly version: number }): { doc: RunConfigDocument; rebased: boolean } {
  const rebased = preset.scenario.id !== scenario.id || preset.scenario.version !== scenario.version;
  return { doc: { ...preset, scenario: { id: scenario.id, version: scenario.version } }, rebased };
}

/** What an entry says about the planner: nothing (inherit), a plain algorithm, or a planning strategy (ADR-0037). */
export type PlannerKind = "inherit" | "algorithm" | "strategy";

export function plannerKind(entry: PlanningEntry | undefined): PlannerKind {
  return entry?.strategy !== undefined ? "strategy" : entry?.algorithm !== undefined ? "algorithm" : "inherit";
}

/** A strategy given by reference (a shipped preset) rather than as an inline document. */
export function strategyRefOf(entry: PlanningEntry | undefined): StrategyRef | undefined {
  const s = entry?.strategy;
  return s !== undefined && "ref" in s ? { ref: s.ref, version: s.version } : undefined;
}

/**
 * Sets the planner of an entry. `algorithm` and `strategy` are one field for precedence (ADR-0028 addition of 2026-10-13),
 * so choosing one clears the other in the same step: the form never produces `strategy_and_algorithm_both_set`.
 */
export function withPlanner(entry: PlanningEntry | undefined, planner: { readonly algorithm: PlanningEntry["algorithm"] } | { readonly strategy: PlanningEntry["strategy"] } | undefined): PlanningEntry {
  const next: PlanningEntry = { ...entry };
  delete next.algorithm;
  delete next.strategy;
  if (planner && "algorithm" in planner && planner.algorithm !== undefined) next.algorithm = planner.algorithm;
  if (planner && "strategy" in planner && planner.strategy !== undefined) next.strategy = planner.strategy;
  return next;
}

export type InlineStrategy = { readonly ok: true; readonly value: PlanningEntry["strategy"] } | { readonly ok: false; readonly code: "invalid_json"; readonly message: string };

/**
 * Reads the inline-strategy editor's text. Only JSON syntax is checked here; every other rule (names, limits, `lazy`
 * placement, budgets) is the resolver's, reported with its own stable code and path by `validateDraft`.
 */
export function parseInlineStrategy(text: string): InlineStrategy {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, code: "invalid_json", message: "a strategy is a JSON object" };
    return { ok: true, value: v as PlanningEntry["strategy"] };
  } catch (e) {
    return { ok: false, code: "invalid_json", message: e instanceof Error ? e.message : "not valid JSON" };
  }
}

export type SectionId = "run" | "planning" | "drive" | "beliefs";
export interface SectionStatus {
  readonly errors: number;
  readonly warnings: number;
}

/** The section of the form a path into the run configuration belongs to; a path into the resolved agents is a planning matter. */
export function sectionOfPath(path: string | undefined): SectionId | undefined {
  if (path === undefined) return undefined;
  if (path.startsWith("/planning") || path.startsWith("/agents")) return "planning";
  if (path.startsWith("/drive")) return "drive";
  if (path.startsWith("/beliefs")) return "beliefs";
  if (path.startsWith("/seed") || path.startsWith("/timeMode")) return "run";
  return undefined;
}

/**
 * The field an error is about: the last key of its path, or else the field the message names ("totalBudget must be…", also after the
 * agent a resolver error is about: `ugv-001 (rover): totalBudget must be…`, whose path is the agent's, not the field's).
 */
export function errorKey(error: {
  readonly path?: string | undefined;
  readonly message?: string | undefined;
}): string | undefined {
  const fromPath = error.path?.startsWith("/agents/")
    ? undefined
    : error.path?.split("/").filter(Boolean).at(-1);
  if (fromPath !== undefined) return fromPath;
  return /(?:^|: )([A-Za-z]\w*) must\b/.exec(error.message ?? "")?.[1];
}

const DRIVE_KEYS = new Set([
  "drive",
  "reverseAllowed",
  "maxReverseSpeedMps",
  "maxYawRateRadps",
  "wheelbaseM",
  "maxSteeringAngleRad",
  "maxSteeringRateRadps",
]);

/** The section an error belongs to: by its path, else by the field it names, else by what its code is about. */
export function sectionOfError(error: {
  readonly code?: string | undefined;
  readonly path?: string | undefined;
  readonly message?: string | undefined;
}): SectionId | undefined {
  const byPath = sectionOfPath(error.path);
  if (byPath) return byPath;
  const key = errorKey(error);
  if (key === "seed" || key === "timeMode") return "run";
  if (key !== undefined && DRIVE_KEYS.has(key)) return "drive";
  if (error.code === "prior_not_found") return "beliefs";
  if (
    error.code === undefined ||
    error.code === "invalid_document" ||
    error.code === "too_large" ||
    error.code === "invalid_json"
  )
    return undefined;
  return "planning";
}

/** Errors and warnings per section, for the rail's glyphs. The resolver's warnings concern planning strategies. */
export function sectionStatus(
  error:
    | {
        readonly code?: string | undefined;
        readonly path?: string | undefined;
        readonly message?: string | undefined;
      }
    | undefined,
  planningWarnings: number,
): Record<SectionId, SectionStatus> {
  const none: SectionStatus = { errors: 0, warnings: 0 };
  const out: Record<SectionId, SectionStatus> = { run: none, planning: none, drive: none, beliefs: none };
  const at = error ? sectionOfError(error) : undefined;
  if (error && at) out[at] = { errors: 1, warnings: 0 };
  out.planning = { errors: out.planning.errors, warnings: planningWarnings };
  return out;
}

/** 1-based numbers of the lines of `draft` (JSON text) that are not among the lines of `base`: what changed against the current run's. */
export function changedLines(base: string, draft: string): Set<number> {
  const seen = new Map<string, number>();
  for (const l of base.split("\n"))
    seen.set(l.trim().replace(/,$/, ""), (seen.get(l.trim().replace(/,$/, "")) ?? 0) + 1);
  const out = new Set<number>();
  draft.split("\n").forEach((l, i) => {
    const k = l.trim().replace(/,$/, "");
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    else if (!/^[}\]]+$/.test(k)) out.add(i + 1); // a closing bracket on its own changes with its opening line
  });
  return out;
}

/** The line of `text` (JSON) that holds the last key of `path`, if there is one. */
export function errorLine(
  text: string,
  error: { readonly path?: string | undefined; readonly message?: string | undefined } | undefined,
): number | undefined {
  const key = error === undefined ? undefined : errorKey(error);
  if (key === undefined) return undefined;
  const i = text.split("\n").findIndex((l) => l.trim().startsWith(`"${key}":`));
  return i < 0 ? undefined : i + 1;
}
