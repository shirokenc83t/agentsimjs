import { err, ok, type CodedError, type Result } from "@agentsim/core";

/**
 * Trace record `source` (ADR-0031): `<owner>/<component>`, the emitter of a record (its subject is
 * `agentId`/`groupId`). Components are a closed vocabulary per owner kind; extending it is a schema
 * change with a test, not an ADR.
 */
export const SOURCE_COMPONENTS = ["body", "sensors", "planner", "actions", "reflexes", "s1", "s2", "comms", "beliefs", "config", "sim", "storage", "protocol", "policy"] as const;
export type SourceComponent = (typeof SOURCE_COMPONENTS)[number];

export type OwnerKind = "agent" | "virtual" | "group" | "protocol" | "world";

// `config`: the agent's resolved configuration at run start and its world-scope changes (ADR-0028 addition of
// 2026-10-10); `source:*/config` finds exactly those records.
export const COMPONENTS_BY_OWNER: Readonly<Record<OwnerKind, readonly SourceComponent[]>> = {
  agent: ["body", "sensors", "planner", "actions", "reflexes", "s1", "s2", "comms", "beliefs", "config"],
  virtual: ["planner", "actions", "s1", "s2", "comms", "beliefs", "config"],
  group: ["policy"],
  protocol: ["protocol"],
  world: ["sim", "storage"],
};

/** Physical agent kinds whose IDs (`uav-007`) are owners (ADR-0015). */
export const PHYSICAL_KINDS = ["uav", "ugv", "ev"] as const;

export const SOURCE_PATTERN = "^[a-z][a-z0-9-]*(#[0-9]+)?/[a-z][a-z0-9]*$";
export const SOURCE_MAX_LENGTH = 96;

const PHYSICAL = new RegExp(`^(${PHYSICAL_KINDS.join("|")})-[0-9]+$`);

/** Kind of an owner string, or undefined if it is not a valid owner. */
export function ownerKind(owner: string): OwnerKind | undefined {
  if (owner === "world") return "world";
  if (/^[a-z][a-z0-9-]*#[0-9]+$/.test(owner)) return "protocol";
  if (/^grp-[0-9]+$/.test(owner)) return "group";
  if (/^virt-[0-9]+$/.test(owner)) return "virtual";
  if (PHYSICAL.test(owner)) return "agent";
  return undefined;
}

export function isComponent(c: string): c is SourceComponent {
  return (SOURCE_COMPONENTS as readonly string[]).includes(c);
}

export interface ParsedSource {
  readonly owner: string;
  readonly component: SourceComponent;
  readonly ownerKind: OwnerKind;
}

// A run has few distinct sources but many records: parsing is memoized (bounded; a pure function).
const parsedCache = new Map<string, ParsedSource | null>();
const PARSED_CACHE_MAX = 4096;

/** Splits and validates a source: shape, length, known owner kind, component allowed for that kind. */
export function parseSource(source: string): ParsedSource | undefined {
  const hit = parsedCache.get(source);
  if (hit !== undefined) return hit ?? undefined;
  const parsed = parseSourceUncached(source);
  if (parsedCache.size >= PARSED_CACHE_MAX) parsedCache.clear();
  parsedCache.set(source, parsed ?? null);
  return parsed;
}

function parseSourceUncached(source: string): ParsedSource | undefined {
  if (source.length > SOURCE_MAX_LENGTH) return undefined;
  const slash = source.indexOf("/");
  if (slash <= 0 || source.indexOf("/", slash + 1) !== -1) return undefined;
  const owner = source.slice(0, slash);
  const component = source.slice(slash + 1);
  const kind = ownerKind(owner);
  if (!kind || !isComponent(component) || !COMPONENTS_BY_OWNER[kind].includes(component)) return undefined;
  return { owner, component, ownerKind: kind };
}

export function isValidSource(source: string): boolean {
  return parseSource(source) !== undefined;
}

/** Builds a source; an invalid combination is a programmer error. */
export function sourceOf(owner: string, component: SourceComponent): string {
  const s = `${owner}/${component}`;
  if (!isValidSource(s)) throw new Error(`invalid trace source ${s}`);
  return s;
}

// ---- filters (log console `source:` term, ADR-0031) ------------------------------------------------

// One filter item: `null` = wildcard segment. A wildcard in both segments is rejected.
export interface SourcePattern {
  readonly owner: string | null;
  readonly component: SourceComponent | null;
}

export type SourceFilterError = CodedError<"invalid_source_filter">;

const MAX_FILTER_ITEMS = 32;

/**
 * Parses the value of a `source:` term: comma-separated `<owner>/<component>`, where either segment may
 * be `*` (whole segment only). Untrusted (typed by the user): every item is validated.
 */
export function parseSourceFilter(value: string): Result<SourcePattern[], SourceFilterError> {
  const bad = (message: string) => err({ code: "invalid_source_filter" as const, message });
  if (value.length > 1024) return bad("source filter too long");
  const items = value.split(",");
  if (items.length > MAX_FILTER_ITEMS) return bad(`at most ${MAX_FILTER_ITEMS} sources per filter`);
  const out: SourcePattern[] = [];
  for (const item of items) {
    const parts = item.split("/");
    if (parts.length !== 2) return bad(`"${item.slice(0, 40)}" is not <owner>/<component>`);
    const [o = "", c = ""] = parts;
    if (o === "*" && c === "*") return bad("*/* matches everything; omit the filter instead");
    const owner = o === "*" ? null : o;
    if (owner !== null && !ownerKind(owner)) return bad(`unknown owner "${o.slice(0, 40)}"`);
    if (c !== "*" && !isComponent(c)) return bad(`unknown component "${c.slice(0, 40)}"`);
    const component = c === "*" ? null : (c as SourceComponent);
    if (owner !== null && component !== null && !isValidSource(`${owner}/${component}`)) return bad(`"${item}" is not a valid source`);
    out.push({ owner, component });
  }
  return ok(out);
}

/** Re-checks patterns received across a boundary (e.g. by the storage worker). */
export function isValidSourcePattern(p: SourcePattern): boolean {
  if (p.owner === null && p.component === null) return false;
  if (p.owner !== null && !ownerKind(p.owner)) return false;
  if (p.component !== null && !isComponent(p.component)) return false;
  return p.owner === null || p.component === null || isValidSource(`${p.owner}/${p.component}`);
}

export function matchesSource(patterns: readonly SourcePattern[], source: string): boolean {
  const p = parseSource(source);
  if (!p) return false;
  return patterns.some((x) => (x.owner === null || x.owner === p.owner) && (x.component === null || x.component === p.component));
}
