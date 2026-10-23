import { err, ok, type CodedError, type Result } from "@agentsim/core";
import { metricDef, type MetricSample } from "./metrics.ts";
import { matchesSource, parseSource, parseSourceFilter, type SourcePattern } from "./source.ts";
import { TRACE_KINDS, type TraceRecord } from "./trace-record.ts";

// The filter language of the log console (UI-SPEC section 5.2; ADR-0035 section 5; ADR-0031 for `source:`): one parser and one AST, two backends. The storage package
// compiles an AST to parameterized SQL (replay); `matchesRecord` and `matchesSample` below are the predicate the storage worker evaluates on incoming batches (live), and
// the in-memory adapter's. The two must select the same records and samples: the equivalence test of the storage worker's recorded fixtures decides.
//
// Space-separated terms, AND; commas are OR inside a term; a leading `-` negates a term. Every value is validated here against a closed vocabulary or a strict shape,
// and the backends only ever receive the parsed form: a value never becomes SQL text.

/** A filter that does not parse: why, and where (`details.at`, the character offset of the term that is wrong). */
export type FilterError = CodedError<"invalid_filter">;

export const FILTER_LIMITS = { maxChars: 1024, maxTerms: 32, maxValues: 32, maxTextChars: 200 } as const;

/** A range of sim time (seconds): `120..300`, `>600`, `>=600`, `<30`, `<=30`, or one instant `45`. */
export interface TimeRange {
  readonly min: number;
  readonly max: number;
  readonly minOpen: boolean;
  readonly maxOpen: boolean;
}

export type FilterTerm = { readonly negated: boolean } & (
  | { readonly key: "agent" | "group" | "kind" | "tier" | "detector" | "status"; readonly values: readonly string[] }
  | { readonly key: "t"; readonly ranges: readonly TimeRange[] }
  | { readonly key: "text"; readonly text: string }
  /** Sequence numbers (`#4812`) of the records in the run being queried. */
  | { readonly key: "cause" | "parent"; readonly seqs: readonly number[] }
  | { readonly key: "source"; readonly patterns: readonly SourcePattern[] }
  | { readonly key: "metric"; readonly names: readonly string[] }
);

export interface FilterAst {
  /** `metrics` when a `metric:` term selects samples, `records` otherwise. */
  readonly target: "records" | "metrics";
  readonly terms: readonly FilterTerm[];
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const WORD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const NUMBER = /^[0-9]+(\.[0-9]+)?$/;
const TIERS = ["S1", "S2", "external"] as const;
/** Keys that make sense for a metric sample: it has a name, a source (so an owner), a sim time. */
const METRIC_KEYS = new Set(["metric", "source", "t", "agent"]);

const bad = (message: string): Result<never, FilterError> => err({ code: "invalid_filter", message });

/** A term of a filter as typed, and where it starts in the text. */
export interface FilterToken {
  readonly text: string;
  readonly at: number;
}

/** Splits on spaces outside double quotes. A quote opens only right after a colon, so `text:"battery low"` is one token. `unclosedAt` is where a quote was left open. */
function scan(text: string): { tokens: FilterToken[]; unclosedAt: number | undefined } {
  const out: FilterToken[] = [];
  let cur = "";
  let curAt = 0;
  let quoteAt: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoteAt !== undefined) {
      cur += c;
      if (c === "\\") {
        i++;
        if (i < text.length) cur += text[i];
      } else if (c === '"') quoteAt = undefined;
    } else if (c === '"' && cur.endsWith(":")) {
      quoteAt = i;
      cur += c;
    } else if (/\s/.test(c)) {
      if (cur !== "") out.push({ text: cur, at: curAt });
      cur = "";
    } else {
      if (cur === "") curAt = i;
      cur += c;
    }
  }
  if (cur !== "") out.push({ text: cur, at: curAt });
  return { tokens: out, unclosedAt: quoteAt };
}

/** The terms of a filter as typed (for editing the text: toggles that add or remove a term); a quote left open is not an error here. */
export function filterTokens(text: string): readonly FilterToken[] {
  return scan(text).tokens;
}

function list(value: string, what: string): Result<string[], FilterError> {
  const items = value.split(",");
  if (items.length > FILTER_LIMITS.maxValues) return bad(`at most ${FILTER_LIMITS.maxValues} values for ${what}`);
  if (items.some((x) => x === "")) return bad(`${what} has an empty value`);
  return ok(items);
}

function number(s: string): number | undefined {
  return NUMBER.test(s) ? Number(s) : undefined;
}

function range(s: string): TimeRange | undefined {
  const dots = s.indexOf("..");
  if (dots >= 0) {
    const a = number(s.slice(0, dots));
    const b = number(s.slice(dots + 2));
    return a === undefined || b === undefined || a > b ? undefined : { min: a, max: b, minOpen: false, maxOpen: false };
  }
  const m = /^(>=|<=|>|<)(.+)$/.exec(s);
  if (m) {
    const n = number(m[2] as string);
    if (n === undefined) return undefined;
    const op = m[1];
    return op === ">" ? { min: n, max: Infinity, minOpen: true, maxOpen: false } : op === ">=" ? { min: n, max: Infinity, minOpen: false, maxOpen: false } : op === "<" ? { min: -Infinity, max: n, minOpen: false, maxOpen: true } : { min: -Infinity, max: n, minOpen: false, maxOpen: false };
  }
  const n = number(s);
  return n === undefined ? undefined : { min: n, max: n, minOpen: false, maxOpen: false };
}

function unquote(value: string): Result<string, FilterError> {
  if (!value.startsWith('"')) return ok(value);
  if (value.length < 2 || !value.endsWith('"')) return bad("a quote is not closed");
  let out = "";
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === "\\") {
      i++;
      if (i >= body.length) return bad("a backslash ends the text");
      out += body[i];
    } else if (c === '"') return bad("an unescaped quote inside the text");
    else out += c;
  }
  return ok(out);
}

function term(token: string): Result<FilterTerm, FilterError> {
  const negated = token.startsWith("-");
  const body = negated ? token.slice(1) : token;
  const colon = body.indexOf(":");
  if (colon <= 0) return bad(`"${token.slice(0, 40)}" is not key:value`);
  const key = body.slice(0, colon);
  const value = body.slice(colon + 1);
  if (value === "") return bad(`${key}: needs a value`);
  switch (key) {
    case "agent":
    case "group": {
      const items = list(value, key);
      if (!items.ok) return items;
      for (const x of items.value) if (!ID.test(x)) return bad(`"${x.slice(0, 40)}" is not an ${key} id`);
      return ok({ negated, key, values: items.value });
    }
    case "kind": {
      const items = list(value, key);
      if (!items.ok) return items;
      for (const x of items.value) if (!(TRACE_KINDS as readonly string[]).includes(x)) return bad(`unknown kind "${x.slice(0, 40)}"`);
      return ok({ negated, key, values: items.value });
    }
    case "tier": {
      const items = list(value, key);
      if (!items.ok) return items;
      for (const x of items.value) if (!(TIERS as readonly string[]).includes(x)) return bad(`unknown tier "${x.slice(0, 40)}" (S1, S2 or external)`);
      return ok({ negated, key, values: items.value });
    }
    case "detector":
    case "status": {
      const items = list(value, key);
      if (!items.ok) return items;
      for (const x of items.value) if (!WORD.test(x)) return bad(`"${x.slice(0, 40)}" is not a ${key} name`);
      return ok({ negated, key, values: items.value });
    }
    case "t": {
      const items = list(value, key);
      if (!items.ok) return items;
      const ranges: TimeRange[] = [];
      for (const x of items.value) {
        const r = range(x);
        if (!r) return bad(`"${x.slice(0, 40)}" is not a time or a range (120..300, >600, <=30)`);
        ranges.push(r);
      }
      return ok({ negated, key, ranges });
    }
    case "text": {
      const text = unquote(value);
      if (!text.ok) return text;
      if (text.value === "" || text.value.length > FILTER_LIMITS.maxTextChars) return bad(`text: takes 1 to ${FILTER_LIMITS.maxTextChars} characters`);
      return ok({ negated, key, text: text.value });
    }
    case "cause":
    case "parent": {
      const items = list(value, key);
      if (!items.ok) return items;
      const seqs: number[] = [];
      for (const x of items.value) {
        if (!/^#[0-9]{1,9}$/.test(x)) return bad(`"${x.slice(0, 40)}" is not a record number (#4812)`);
        seqs.push(Number(x.slice(1)));
      }
      return ok({ negated, key, seqs });
    }
    case "source": {
      const patterns = parseSourceFilter(value);
      return patterns.ok ? ok({ negated, key, patterns: patterns.value }) : bad(patterns.error.message);
    }
    case "metric": {
      const items = list(value, key);
      if (!items.ok) return items;
      for (const x of items.value) if (metricDef(x) === undefined) return bad(`"${x.slice(0, 40)}" is not a metric of the registry`);
      return ok({ negated, key, names: items.value });
    }
    default:
      return bad(`unknown key "${key.slice(0, 40)}"`);
  }
}

/** Parses a filter typed by the researcher. Untrusted input: every value is checked; a bad filter is an error, never a partial one. */
export function parseFilter(text: string): Result<FilterAst, FilterError> {
  if (typeof text !== "string" || text.length > FILTER_LIMITS.maxChars) return err({ code: "invalid_filter", message: `a filter is at most ${FILTER_LIMITS.maxChars} characters`, details: { at: FILTER_LIMITS.maxChars } });
  const scanned = scan(text);
  if (scanned.unclosedAt !== undefined) return err({ code: "invalid_filter", message: "a quote is not closed", details: { at: scanned.unclosedAt } });
  const tokens = scanned.tokens;
  if (tokens.length > FILTER_LIMITS.maxTerms) return err({ code: "invalid_filter", message: `at most ${FILTER_LIMITS.maxTerms} terms`, details: { at: (tokens[FILTER_LIMITS.maxTerms] as FilterToken).at } });
  const terms: FilterTerm[] = [];
  for (const token of tokens) {
    const t = term(token.text);
    if (!t.ok) return err({ ...t.error, details: { at: token.at } });
    terms.push(t.value);
  }
  const target = terms.some((t) => t.key === "metric") ? "metrics" : "records";
  if (target === "metrics") {
    const i = terms.findIndex((t) => !METRIC_KEYS.has(t.key));
    if (i >= 0) return err({ code: "invalid_filter", message: `${(terms[i] as FilterTerm).key}: does not apply to metric samples (they have a name, a source and a time)`, details: { at: (tokens[i] as FilterToken).at } });
  }
  return ok({ target, terms });
}

// ---- the live predicate ---------------------------------------------------------------------------------------------------

/** Lower-cases ASCII letters only: SQLite's `lower()` does the same, so a text term means the same in both backends. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The text a `text:` term searches: the record's payload as JSON, as it is stored. */
export const payloadText = (r: Pick<TraceRecord, "payload">): string => JSON.stringify(r.payload ?? null);

function inRange(t: number, r: TimeRange): boolean {
  return (r.minOpen ? t > r.min : t >= r.min) && (r.maxOpen ? t < r.max : t <= r.max);
}

function recordTerm(t: FilterTerm, r: TraceRecord): boolean {
  switch (t.key) {
    case "agent":
      return r.agentId !== undefined && t.values.includes(r.agentId);
    case "group":
      return r.groupId !== undefined && t.values.includes(r.groupId);
    case "kind":
      return t.values.includes(r.kind);
    case "tier":
      return r.tier !== undefined && t.values.includes(r.tier);
    case "detector":
    case "status": {
      const p = r.payload;
      const v = p !== null && typeof p === "object" ? (p as Record<string, unknown>)[t.key] : undefined;
      return typeof v === "string" && t.values.includes(v);
    }
    case "t":
      return t.ranges.some((x) => inRange(r.simTime, x));
    case "text":
      return asciiLower(payloadText(r)).includes(asciiLower(t.text));
    case "cause":
      return (r.causeIds ?? []).some((c) => t.seqs.some((s) => c === `${r.runId}#${s}`));
    case "parent":
      return r.parentId !== undefined && t.seqs.some((s) => r.parentId === `${r.runId}#${s}`);
    case "source":
      return matchesSource(t.patterns, r.source);
    case "metric":
      return false;
  }
}

/** True when a trace record satisfies the filter (every term, the negated ones inverted). The live backend, and the in-memory adapter's. */
export function matchesRecord(ast: FilterAst, r: TraceRecord): boolean {
  if (ast.target !== "records") return false;
  return ast.terms.every((t) => recordTerm(t, r) !== t.negated);
}

function sampleTerm(t: FilterTerm, s: MetricSample): boolean {
  switch (t.key) {
    case "metric":
      return t.names.includes(s.name);
    case "source":
      return matchesSource(t.patterns, s.source);
    case "t":
      return t.ranges.some((x) => inRange(s.simTime, x));
    case "agent": {
      const owner = parseSource(s.source)?.owner;
      return owner !== undefined && t.values.includes(owner);
    }
    default:
      return false;
  }
}

/** True when a metric sample satisfies a metric filter. */
export function matchesSample(ast: FilterAst, s: MetricSample): boolean {
  if (ast.target !== "metrics") return false;
  return ast.terms.every((t) => sampleTerm(t, s) !== t.negated);
}
