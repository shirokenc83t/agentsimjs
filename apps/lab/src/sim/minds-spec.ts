import type { SimLoadMessage } from "@agentsim/core";
import type { StoragePorts } from "@agentsim/storage";
import type { ProviderEntry } from "../config/providers.ts";

// What a run with System 2 minds needs besides its run configuration (F4 M3): the library documents the configuration refers to and the provider entries of Settings, by id, with the address and the prices and
// never a key (the key reaches the worker in a message of its own). A run configuration with no `s2` entry needs none of it: nothing is sent and the run is what it always was.

type Spec = NonNullable<SimLoadMessage["minds"]>;
type Ref = { readonly id: string; readonly version: number };

const isRef = (v: unknown): v is Ref => typeof v === "object" && v !== null && typeof (v as Ref).id === "string" && Number.isInteger((v as Ref).version);

/** The profile and template references of the `s2` entries of a run configuration (anywhere under `minds`), each once. */
export function s2References(runConfig: unknown): { readonly profiles: readonly Ref[]; readonly templates: readonly Ref[] } {
  const profiles = new Map<string, Ref>();
  const templates = new Map<string, Ref>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const s2 = o["s2"] as { profile?: unknown; overrides?: { promptTemplate?: unknown } } | undefined;
    if (typeof s2 === "object" && s2 !== null) {
      if (isRef(s2.profile)) profiles.set(`${s2.profile.id}@${s2.profile.version}`, { id: s2.profile.id, version: s2.profile.version });
      if (isRef(s2.overrides?.promptTemplate)) templates.set(`${s2.overrides.promptTemplate.id}@${s2.overrides.promptTemplate.version}`, { id: s2.overrides.promptTemplate.id, version: s2.overrides.promptTemplate.version });
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk((runConfig as { minds?: unknown } | undefined)?.minds, 0);
  return { profiles: [...profiles.values()], templates: [...templates.values()] };
}

/** The `minds` part of a load message for this run configuration, or undefined when no agent has an S2 mind. */
export async function mindsSpecFor(ports: Pick<StoragePorts, "mindProfiles" | "promptTemplates">, providers: readonly ProviderEntry[], runConfig: unknown): Promise<Spec | undefined> {
  const refs = s2References(runConfig);
  if (refs.profiles.length === 0) return undefined;
  const profiles: Spec["profiles"][number][] = [];
  const templateRefs = new Map(refs.templates.map((t) => [`${t.id}@${t.version}`, t]));
  for (const r of refs.profiles) {
    const doc = await ports.mindProfiles.get(r.id, r.version);
    if (doc === undefined) continue; // the resolution of the run configuration says which profile is missing
    profiles.push({ id: r.id, version: r.version, document: doc.document });
    const t = (doc.document as { s2?: { promptTemplate?: unknown } } | undefined)?.s2?.promptTemplate;
    if (isRef(t)) templateRefs.set(`${t.id}@${t.version}`, { id: t.id, version: t.version });
  }
  // The built-in default template (`default` v1) is the worker's own: it is added there when a profile names it.
  const templates: Spec["templates"][number][] = [];
  for (const r of templateRefs.values()) {
    if (r.id === "default" && r.version === 1) continue;
    const doc = await ports.promptTemplates.get(r.id, r.version);
    if (doc !== undefined) templates.push({ id: r.id, version: r.version, document: doc.document });
  }
  return {
    profiles,
    templates,
    providers: providers.map((p) => ({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, ...(p.prices === undefined ? {} : { prices: p.prices }) })),
  };
}
