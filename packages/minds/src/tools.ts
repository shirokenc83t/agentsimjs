import { capabilityManifest } from "@agentsim/tools-schema";
import type { ToolDefinition } from "./provider.ts";

// The compute tools as the provider is offered them (ADR-0005 addition of 2026-10-29, ADR-0014 addition of the same day): generated from the one capability manifest, never written by hand, so the name,
// the description and the parameter schema a model sees are exactly the capability's. A profile's `tools.allow` list names the tools (actions and compute tools alike) the mind may use.

let all: readonly ToolDefinition[] | undefined;

/** Every compute tool of the manifest, in its order (sorted by name). */
export function computeToolDefinitions(): readonly ToolDefinition[] {
  all ??= capabilityManifest()
    .capabilities.filter((c) => c.kind === "compute")
    .map((c) => ({ name: c.name, description: c.description, paramsSchema: c.params }));
  return all;
}

/** The compute tools a profile offers: all of them, or those its `tools.allow` names. */
export function offeredComputeTools(allow: readonly string[] | undefined): readonly ToolDefinition[] {
  return allow === undefined ? computeToolDefinitions() : computeToolDefinitions().filter((t) => allow.includes(t.name));
}
