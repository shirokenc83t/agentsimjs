import { err, ok, type CapabilityPort, type Scope } from "@agentsim/core";
import { capabilityManifest, getCapability, isInjectable, validateParams } from "@agentsim/tools-schema";

/** The capabilities and their parameter schemas, from the generated manifest (built once: it never changes at run time). */
let menu: readonly { readonly name: string; readonly kind: "action" | "bookkeeping"; readonly paramsSchema: Readonly<Record<string, unknown>> }[] | undefined;
function capabilityMenu(): NonNullable<typeof menu> {
  menu ??= capabilityManifest().capabilities.map((c) => ({ name: c.name, kind: c.kind, paramsSchema: c.params }));
  return menu;
}

/** CapabilityPort over tools-schema (ADR-0007): the only source of capability definitions. */
export const toolsSchemaCapabilities: CapabilityPort = {
  list: () => capabilityMenu(),
  kind: (name) => getCapability(name)?.kind ?? "action",
  injectable: (name) => isInjectable(name),
  validate: (name, params) => {
    const r = validateParams(name, params);
    return r.ok ? ok(r.value) : err({ code: r.error.code, message: r.error.message });
  },
  vehicles: (name) => getCapability(name)?.vehicles ?? [],
  scope: (name): Scope => getCapability(name)?.scope ?? "self",
  preconditions: (name) => getCapability(name)?.preconditions ?? [],
};

