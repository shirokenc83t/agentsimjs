import type { CapabilityDef } from "../capability.ts";
import { CAPABILITIES, COMMON_FAILURE_CODES, PRECONDITIONS } from "../registry.ts";

export const MANIFEST_SCHEMA_VERSION = 1;

/** Plain JSON Schema (TypeBox 1.x schemas serialize to standard JSON Schema). */
export type JsonSchema = Record<string, unknown>;

export interface CapabilityManifestEntry {
  readonly name: string;
  readonly kind: CapabilityDef["kind"];
  readonly description: string;
  readonly vehicles: readonly string[];
  readonly scope: CapabilityDef["scope"];
  readonly preconditions: readonly { readonly name: string; readonly vehicles?: readonly string[]; readonly description: string }[];
  readonly failureCodes: readonly string[];
  readonly params: JsonSchema;
  readonly result: JsonSchema;
}

export interface CapabilityManifest {
  readonly schemaVersion: number;
  readonly commonFailureCodes: readonly string[];
  readonly capabilities: readonly CapabilityManifestEntry[];
}

function plain(schema: unknown): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

/**
 * The canonical generated exposure (ADR-0007): every capability as plain JSON Schema with its metadata.
 * Provider tool definitions, MQTT payloads and MCP tools (F4, F5, FM) are generated from this, never
 * hand-written. Deterministic: capabilities sorted by name.
 */
export function capabilityManifest(): CapabilityManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    commonFailureCodes: [...COMMON_FAILURE_CODES],
    capabilities: CAPABILITIES.map((c) => ({
      name: c.name,
      kind: c.kind,
      description: c.description,
      vehicles: [...c.vehicles],
      scope: c.scope,
      preconditions: c.preconditions.map((p) => ({ ...p, description: PRECONDITIONS[p.name] })),
      failureCodes: [...c.failureCodes],
      params: plain(c.params),
      result: plain(c.result),
    })),
  };
}
