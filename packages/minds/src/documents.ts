import { err, ok, validate, type CodedError, type Result } from "@agentsim/core";
import Type, { type Static } from "typebox";
import { canonicalJson, hash32Hex } from "./canonical.ts";

// The mind documents of ADR-0036 and its F4 addition: a `MindProfile` of the `s2` shape and a `PromptTemplate`. Both are canonical documents (TypeBox, limits, JSON), versioned by the library,
// hashed from their canonical form. A template is not a template engine: it has fixed named slots the prompt builder fills, and anything that looks like an expression is refused.

export type MindErrorCode = "invalid_document" | "limit_out_of_range" | "template_slot_unknown" | "mind_shape_mismatch";
export type MindError = CodedError<MindErrorCode> & { readonly path?: string };

const fail = (code: MindErrorCode, message: string, path?: string): { ok: false; error: MindError } => err(path === undefined ? { code, message } : { code, message, path });

/** The defaults of the ADR-0036 addition of 2026-10-29: what a profile that leaves a field out gets. They are part of what a run is, so a change of one is a change of every hash that leaves it out. */
export const MIND_DEFAULTS = {
  limits: { calls: 20, tokens: 40_000, costUsd: 0.05, timeoutS: 60, retries: 1 },
  tools: { maxCallsPerDecision: 8 },
  context: { decisions: 5 },
  latency: { model: "measured" },
} as const;

/** The ranges of the same addition, inclusive. */
export const MIND_RANGES = {
  "limits.calls": [1, 100_000],
  "limits.tokens": [1_000, 100_000_000],
  "limits.costUsd": [0, 1_000],
  "limits.timeoutS": [5, 600],
  "limits.retries": [0, 3],
  "context.decisions": [0, 50],
  "tools.maxCallsPerDecision": [0, 16],
} as const;

const Id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });

const Params = Type.Object(
  {
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_768 })),
    topP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

// The ranges of the limits are checked after the shape, so that a value out of range has its own stable code and names its field.
const Limits = Type.Object(
  {
    calls: Type.Optional(Type.Number()),
    tokens: Type.Optional(Type.Number()),
    costUsd: Type.Optional(Type.Number()),
    timeoutS: Type.Optional(Type.Number()),
    retries: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

const Tools = Type.Object({ allow: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })), maxCallsPerDecision: Type.Optional(Type.Number()) }, { additionalProperties: false });
const Context = Type.Object({ decisions: Type.Optional(Type.Number()) }, { additionalProperties: false });
const Latency = Type.Object({ model: Type.Union([Type.Literal("fixed"), Type.Literal("measured")]), fixedMs: Type.Optional(Type.Number({ minimum: 0, maximum: 600_000 })) }, { additionalProperties: false });
const TemplateRef = Type.Object({ id: Id, version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });

/** The System 2 section of a profile (ADR-0036 section 2). `provider` names an entry of Settings, never holds a key. */
export const S2Profile = Type.Object(
  {
    provider: Id,
    model: Type.String({ minLength: 1, maxLength: 200 }),
    params: Type.Optional(Params),
    promptTemplate: TemplateRef,
    tools: Type.Optional(Tools),
    context: Type.Optional(Context),
    limits: Type.Optional(Limits),
    latency: Type.Optional(Latency),
  },
  { additionalProperties: false },
);
export type S2Profile = Static<typeof S2Profile>;

/** What a run configuration may change of a profile for one agent, field by field. */
export const S2Overrides = Type.Object(
  {
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    params: Type.Optional(Params),
    promptTemplate: Type.Optional(TemplateRef),
    tools: Type.Optional(Tools),
    context: Type.Optional(Context),
    limits: Type.Optional(Limits),
    latency: Type.Optional(Latency),
  },
  { additionalProperties: false },
);
export type S2Overrides = Static<typeof S2Overrides>;

export const MIND_PROFILE_SCHEMA_VERSION = 1;

export const MindProfileDocument = Type.Object(
  { schemaVersion: Type.Literal(MIND_PROFILE_SCHEMA_VERSION), kind: Type.Literal("mind-profile"), shape: Type.Literal("s2"), s2: S2Profile },
  { additionalProperties: false },
);
export type MindProfileDocument = Static<typeof MindProfileDocument>;

/** The range check of the limits, the context and the tool cap: the first value out of range, with its field path. */
export function checkRanges(s: { readonly limits?: object | undefined; readonly context?: object | undefined; readonly tools?: object | undefined }, prefix = ""): MindError | undefined {
  const groups = { limits: s.limits, context: s.context, tools: s.tools } as Record<string, Record<string, unknown> | undefined>;
  for (const [path, [lo, hi]] of Object.entries(MIND_RANGES) as [keyof typeof MIND_RANGES, readonly [number, number]][]) {
    const [group, field] = path.split(".") as [string, string];
    const v = groups[group]?.[field];
    if (v === undefined) continue;
    const integer = field !== "costUsd" && field !== "timeoutS";
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) {
      return { code: "limit_out_of_range", message: `${path} must be ${integer ? "an integer " : ""}in [${lo}, ${hi}], got ${String(v)}`, path: `${prefix}${path}` };
    }
  }
  return undefined;
}

/** Validates a profile document: the shape, the ranges, the shapes that are not built yet. */
export function validateMindProfile(doc: unknown): Result<MindProfileDocument, MindError> {
  const shape = (doc as { shape?: unknown } | null)?.shape;
  if (typeof doc === "object" && doc !== null && (shape === "s1" || shape === "s1+s2")) return fail("mind_shape_mismatch", `F4 builds the s2 shape only, got "${String(shape)}"`, "shape");
  const r = validate(MindProfileDocument, doc);
  if (!r.ok) {
    const first = r.error.issues[0];
    return fail("invalid_document", first ? `${first.path || "/"}: ${first.message}` : r.error.message, first?.path);
  }
  const range = checkRanges(r.value.s2);
  if (range !== undefined) return err(range);
  const allow = r.value.s2.tools?.allow;
  if (allow !== undefined && new Set(allow).size !== allow.length) return fail("invalid_document", "tools.allow names a tool twice", "tools.allow");
  return ok(r.value);
}

/** Where a field of the effective mind came from: the built-in default, the profile, or the run configuration's override. */
export type MindSource = "default" | "profile" | "override";

export interface EffectiveS2 {
  readonly provider: string;
  readonly model: string;
  readonly params: NonNullable<S2Profile["params"]>;
  readonly promptTemplate: { readonly id: string; readonly version: number };
  readonly tools: { readonly allow?: readonly string[]; readonly maxCallsPerDecision: number };
  readonly context: { readonly decisions: number };
  readonly limits: { readonly calls: number; readonly tokens: number; readonly costUsd: number; readonly timeoutS: number; readonly retries: number };
  readonly latency: { readonly model: "fixed" | "measured"; readonly fixedMs?: number };
  /** The level of each field, by dotted path (`model`, `limits.calls`, `params.temperature`, …). */
  readonly sources: Readonly<Record<string, MindSource>>;
}

/** The effective System 2 mind: default → profile → override, field by field (ADR-0036 section 6). */
export function resolveS2(profile: S2Profile, overrides: S2Overrides | undefined): EffectiveS2 {
  const sources: Record<string, MindSource> = {};
  const pick = <T>(path: string, def: T | undefined, prof: T | undefined, over: T | undefined): T | undefined => {
    const v = over ?? prof ?? def;
    sources[path] = over !== undefined ? "override" : prof !== undefined ? "profile" : "default";
    return v;
  };
  const group = <K extends string>(name: string, keys: readonly K[], def: Partial<Record<K, unknown>>, prof: Partial<Record<K, unknown>> | undefined, over: Partial<Record<K, unknown>> | undefined): Record<K, unknown> => {
    const out = {} as Record<K, unknown>;
    for (const k of keys) {
      const v = pick(`${name}.${k}`, def[k], prof?.[k], over?.[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const model = pick("model", undefined, profile.model, overrides?.model) as string;
  const template = pick("promptTemplate", undefined, profile.promptTemplate, overrides?.promptTemplate) as { id: string; version: number };
  const provider = pick("provider", undefined, profile.provider, undefined) as string;
  const params = group("params", ["temperature", "maxOutputTokens", "topP"], {}, profile.params, overrides?.params) as EffectiveS2["params"];
  const limits = group("limits", ["calls", "tokens", "costUsd", "timeoutS", "retries"], MIND_DEFAULTS.limits, profile.limits, overrides?.limits) as EffectiveS2["limits"];
  const context = group("context", ["decisions"], MIND_DEFAULTS.context, profile.context, overrides?.context) as EffectiveS2["context"];
  const tools = group("tools", ["maxCallsPerDecision", "allow"], MIND_DEFAULTS.tools, profile.tools, overrides?.tools) as EffectiveS2["tools"];
  const latency = group("latency", ["model", "fixedMs"], MIND_DEFAULTS.latency, profile.latency, overrides?.latency) as EffectiveS2["latency"];
  return { provider, model, params, promptTemplate: template, tools, context, limits, latency, sources };
}

// ---- prompt templates -----------------------------------------------------------------------------------------------------------------------------

/** The slots the prompt builder fills, in no particular order: a template names the ones it uses and in what order. */
export const SLOTS = ["role", "mission", "notebook", "decisions", "self", "beliefs", "space", "events", "actions"] as const;
export type Slot = (typeof SLOTS)[number];

export const PROMPT_TEMPLATE_SCHEMA_VERSION = 1;

export const PromptTemplateDocument = Type.Object(
  {
    schemaVersion: Type.Literal(PROMPT_TEMPLATE_SCHEMA_VERSION),
    kind: Type.Literal("prompt-template"),
    /** The role and the system text: literal text, never evaluated. */
    system: Type.String({ minLength: 1, maxLength: 8_000 }),
    sections: Type.Array(Type.String({ maxLength: 32 }), { minItems: 1, maxItems: SLOTS.length }),
    instructions: Type.Optional(Type.Record(Type.String({ maxLength: 32 }), Type.String({ maxLength: 1_000 }), { maxProperties: SLOTS.length })),
  },
  { additionalProperties: false },
);
export type PromptTemplateDocument = Static<typeof PromptTemplateDocument>;

/** Text that looks like an expression, a placeholder or code: refused wherever the template carries text (CLAUDE.md: no evaluation of content that can be shared). */
const EXPRESSION_LIKE = /\{\{|\}\}|\$\{|\{%|%\}|<%|%>|\{#|#\}/;

export function validatePromptTemplate(doc: unknown): Result<PromptTemplateDocument, MindError> {
  const r = validate(PromptTemplateDocument, doc);
  if (!r.ok) {
    const first = r.error.issues[0];
    return fail("invalid_document", first ? `${first.path || "/"}: ${first.message}` : r.error.message, first?.path);
  }
  const t = r.value;
  const known = new Set<string>(SLOTS);
  for (const [i, s] of t.sections.entries()) if (!known.has(s)) return fail("template_slot_unknown", `section ${i + 1}: "${s}" is not a slot (the slots are ${SLOTS.join(", ")})`, `sections/${i}`);
  if (new Set(t.sections).size !== t.sections.length) return fail("invalid_document", "a slot is named twice in sections", "sections");
  if (EXPRESSION_LIKE.test(t.system)) return fail("template_slot_unknown", "the system text has expression-like syntax; a template has fixed slots and no expressions", "system");
  for (const [slot, text] of Object.entries(t.instructions ?? {})) {
    if (!known.has(slot)) return fail("template_slot_unknown", `instruction for "${slot}": not a slot`, `instructions/${slot}`);
    if (EXPRESSION_LIKE.test(text)) return fail("template_slot_unknown", `instruction for "${slot}" has expression-like syntax`, `instructions/${slot}`);
  }
  return ok(t);
}

/** The template that ships: a short role, every slot in the order a decision reads best. */
export const DEFAULT_PROMPT_TEMPLATE: PromptTemplateDocument = {
  schemaVersion: PROMPT_TEMPLATE_SCHEMA_VERSION,
  kind: "prompt-template",
  system:
    "You are the mind of one vehicle in a simulation. You see only what the vehicle senses and believes, never the world itself. " +
    "Each turn you receive what happened, what you may do, and your own notes. Answer with exactly one action from the allowed list, or idle to wait for the next event. " +
    "You may also keep notes for yourself; they are returned to you in every prompt.",
  sections: ["role", "mission", "notebook", "decisions", "self", "beliefs", "space", "events", "actions"],
};

// ---- hashes ----------------------------------------------------------------------------------------------------------------------------------------

/** The canonical text of a document. */
export const canonicalDocument = (doc: unknown): string => canonicalJson(doc);

/** The content hash of a document (xxHash32 of its canonical form, 8 hex digits): the same whatever the order of the keys. */
export const documentHash = (doc: unknown): string => hash32Hex(canonicalJson(doc));
