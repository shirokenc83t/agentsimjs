import { validate, type AllowedAction, type Decision, type NoteOp, type TimerOp } from "@agentsim/core";
import type { TSchema } from "typebox";
import type { JsonSchema } from "./provider.ts";

// The final answer of a decision (ADR-0005 addition of 2026-10-29): one allowed action with its parameters, or `idle`, optionally with timers, a note for the notebook and a rationale. Its JSON
// Schema is generated from the request's allowed actions (their parameter schemas come from the one capability manifest), so what the model is asked for and what is accepted cannot differ.

const TAG = "^[a-z][a-z0-9-]{0,31}$";

const TIMERS: JsonSchema = {
  type: "array",
  maxItems: 16,
  items: {
    anyOf: [
      { type: "object", additionalProperties: false, required: ["op", "tag", "delayS"], properties: { op: { const: "set" }, tag: { type: "string", pattern: TAG }, delayS: { type: "number" } } },
      { type: "object", additionalProperties: false, required: ["op", "tag"], properties: { op: { const: "cancel" }, tag: { type: "string", pattern: TAG } } },
    ],
  },
};

const NOTE: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "mode"],
  properties: { text: { type: "string" }, mode: { enum: ["replace", "append"] } },
};

const OPTIONAL: Record<string, JsonSchema> = { timers: TIMERS, note: NOTE, rationale: { type: "string", maxLength: 2000 } };

/** The schema of the final answer for these allowed actions: a variant per action (its `action` name and its exact parameters) and one for `idle`. Deterministic: the actions in the order given. */
export function answerSchema(allowed: readonly AllowedAction[]): JsonSchema {
  const variants: JsonSchema[] = allowed.map((a) => ({
    type: "object",
    additionalProperties: false,
    required: ["action", "params"],
    properties: { action: { const: a.name }, params: a.paramsSchema, ...OPTIONAL },
  }));
  variants.push({ type: "object", additionalProperties: false, required: ["action"], properties: { action: { const: "idle" }, ...OPTIONAL } });
  return { anyOf: variants };
}

export interface ParsedAnswer {
  readonly decision: Decision;
  readonly timers?: readonly TimerOp[];
  readonly note?: NoteOp;
  readonly rationale?: string;
}

/** The first JSON object of a text: from the first `{` to the brace that closes it (braces inside a string do not count). */
function firstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Takes the JSON out of an answer: the whole text, the first fenced block (a model that wraps its JSON in a code fence still answers), or the first object of a text with words around it. */
function jsonOf(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
    const piece = fenced?.[1]?.trim() ?? firstObject(t);
    if (piece === undefined) throw new SyntaxError("the answer is not JSON");
    return JSON.parse(piece);
  }
}

/** A compute tool written as the action of an answer (`{"action": "estimateCost", "params": {...}}`): what a model does that does not use the function-calling channel. The tool and its parameters, or undefined. */
export function toolWrittenAsAction(text: string, toolNames: readonly string[]): { readonly name: string; readonly params: unknown } | undefined {
  let raw: unknown;
  try {
    raw = jsonOf(text);
  } catch {
    return undefined;
  }
  const o = raw as { action?: unknown; params?: unknown } | null;
  if (o === null || typeof o !== "object" || typeof o.action !== "string" || !toolNames.includes(o.action)) return undefined;
  if (o.params !== undefined && (o.params === null || typeof o.params !== "object" || Array.isArray(o.params))) return undefined;
  return { name: o.action, params: o.params ?? {} };
}

/** Parses and validates an answer against the schema made for the request; the message of a failure is what the model is told in the retry. */
export function parseAnswer(text: string, schema: JsonSchema): { readonly ok: true; readonly value: ParsedAnswer } | { readonly ok: false; readonly message: string } {
  let raw: unknown;
  try {
    raw = jsonOf(text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "the answer is not JSON" };
  }
  const v = validate(schema as TSchema, raw);
  if (!v.ok) {
    const first = v.error.issues[0];
    const actionOf = (raw as { action?: unknown } | null)?.action;
    return { ok: false, message: `${typeof actionOf === "string" ? `for action "${actionOf}", ` : ""}${first === undefined ? "the answer does not match the schema" : `${first.path === "" ? "answer" : first.path}: ${first.message}`}` };
  }
  const a = v.value as { action: string; params?: unknown; timers?: TimerOp[]; note?: NoteOp; rationale?: string };
  return {
    ok: true,
    value: {
      decision: a.action === "idle" ? { kind: "idle" } : { kind: "action", name: a.action, params: a.params ?? {} },
      ...(a.timers === undefined || a.timers.length === 0 ? {} : { timers: a.timers }),
      ...(a.note === undefined ? {} : { note: a.note }),
      ...(a.rationale === undefined || a.rationale === "" ? {} : { rationale: a.rationale }),
    },
  };
}
