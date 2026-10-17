import { BUILTIN_BODY_DEFAULTS, resolveBody, UavBody, UgvBody, ugvBodyWarnings, type AgentSpec, type BodyWarning } from "@agentsim/scenarios";

/**
 * Body form fields generated from the body schemas (ADR-0025, ADR-0033), so the form cannot drift from what
 * the loader accepts: one field per scalar property, nested objects (battery, energy) flattened one level.
 * Each field shows the built-in default as its placeholder; an empty field means "use the default".
 */
export type BodyField =
  | { readonly path: readonly string[]; readonly kind: "number" | "integer"; readonly min?: number; readonly max?: number; readonly exclusiveMin?: number }
  | { readonly path: readonly string[]; readonly kind: "boolean" }
  | { readonly path: readonly string[]; readonly kind: "enum"; readonly options: readonly string[] };

interface JsonSchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly anyOf?: readonly { readonly const?: unknown }[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
}

function fieldsOf(node: JsonSchemaNode, prefix: readonly string[]): BodyField[] {
  const out: BodyField[] = [];
  for (const [name, p] of Object.entries(node.properties ?? {})) {
    const path = [...prefix, name];
    if (p.type === "object") out.push(...fieldsOf(p, path));
    else if (p.type === "number" || p.type === "integer")
      out.push({
        path,
        kind: p.type,
        ...(p.minimum === undefined ? {} : { min: p.minimum }),
        ...(p.maximum === undefined ? {} : { max: p.maximum }),
        ...(p.exclusiveMinimum === undefined ? {} : { exclusiveMin: p.exclusiveMinimum }),
      });
    else if (p.type === "boolean") out.push({ path, kind: "boolean" });
    else if (p.anyOf?.every((o) => typeof o.const === "string")) out.push({ path, kind: "enum", options: p.anyOf.map((o) => String(o.const)) });
  }
  return out;
}

export const BODY_FIELDS: Readonly<Record<AgentSpec["kind"], readonly BodyField[]>> = {
  uav: fieldsOf(UavBody as JsonSchemaNode, []),
  ugv: fieldsOf(UgvBody as JsonSchemaNode, []),
};

const at = (o: unknown, path: readonly string[]): unknown => path.reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** The value authored in the scenario for a field, if any. */
export function bodyValue(agent: AgentSpec, path: readonly string[]): unknown {
  return at(agent.body ?? {}, path);
}

/** The value the loader will use for a field: the authored one or the built-in default (shown as placeholder). */
export function effectiveBodyValue(agent: AgentSpec, path: readonly string[]): unknown {
  const resolved = agent.kind === "uav" ? resolveBody("uav", agent.body ?? {}, BUILTIN_BODY_DEFAULTS) : resolveBody("ugv", agent.body ?? {}, BUILTIN_BODY_DEFAULTS);
  return at(resolved, path);
}

/** Sets (or clears, with `undefined`) one body field; empty nested objects and an empty body are removed. */
export function withBodyValue(agent: AgentSpec, path: readonly string[], value: unknown): AgentSpec {
  const set = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined => {
    const [k, ...rest] = keys;
    if (k === undefined) return o;
    const next = { ...o };
    if (rest.length === 0) {
      if (value === undefined) delete next[k];
      else next[k] = value;
    } else {
      const child = set((o[k] as Record<string, unknown> | undefined) ?? {}, rest);
      if (child === undefined) delete next[k];
      else next[k] = child;
    }
    return Object.keys(next).length === 0 ? undefined : next;
  };
  const body = set((agent.body ?? {}) as Record<string, unknown>, path);
  const { body: _old, ...rest } = agent;
  return (body === undefined ? rest : { ...rest, body }) as AgentSpec;
}

/** Non-blocking consistency warnings of a UGV body (stable codes), as the loader reports them. */
export function bodyWarnings(agent: AgentSpec, index: number): readonly BodyWarning[] {
  return agent.kind === "ugv" ? ugvBodyWarnings(resolveBody("ugv", agent.body ?? {}), `/agents/${index}/body`) : [];
}
