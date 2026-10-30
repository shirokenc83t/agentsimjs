import { createMemoryPorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import type { ProviderEntry } from "../config/providers.ts";
import { mindsSpecFor, s2References } from "./minds-spec.ts";

// What a load carries for a run with System 2 minds (F4 M3): the library documents the run configuration refers to and the providers of Settings, never a key.

const profile = (template = { id: "default", version: 1 }) => ({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local", model: "m", promptTemplate: template } });
const provider: ProviderEntry = { id: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434", rememberKey: true, models: ["m"], prices: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 }, tested: { atMs: 1, ok: true, summary: "x" } };
const config = { minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 2 }, mission: "go" } } }, default: { s2: { profile: { id: "other", version: 1 }, overrides: { promptTemplate: { id: "terse", version: 3 } } } } } };

describe("the minds part of a load", () => {
  it("finds the profiles and the templates a run configuration names, wherever its s2 entries are", () => {
    expect(s2References(config)).toEqual({ profiles: [{ id: "scout-llm", version: 2 }, { id: "other", version: 1 }], templates: [{ id: "terse", version: 3 }] });
    expect(s2References({ minds: { byAgent: { a: { s1: { script: {} } } } } })).toEqual({ profiles: [], templates: [] });
    expect(s2References(undefined)).toEqual({ profiles: [], templates: [] });
  });

  it("is nothing for a run with no S2 mind, and for one with: the profiles and templates from the library, the default template, and the providers without a key", async () => {
    const ports = createMemoryPorts();
    expect(await mindsSpecFor(ports, [provider], { minds: { byAgent: {} } })).toBeUndefined();
    expect((await ports.mindProfiles.saveVersion({ id: "scout-llm", name: "Scout", document: profile() })).ok).toBe(true);
    await ports.mindProfiles.saveVersion({ id: "scout-llm", name: "Scout", document: profile({ id: "terse", version: 1 }) }); // version 2
    await ports.mindProfiles.saveVersion({ id: "other", name: "Other", document: profile() });
    await ports.promptTemplates.saveVersion({ id: "terse", name: "Terse", document: { schemaVersion: 1, kind: "prompt-template", system: "s", sections: ["role"] } });
    const spec = await mindsSpecFor(ports, [provider], config);
    expect(spec?.profiles.map((p) => `${p.id}@${p.version}`).sort()).toEqual(["other@1", "scout-llm@2"]);
    expect(spec?.templates.map((t) => `${t.id}@${t.version}`).sort()).toEqual(["terse@1"]); // default@1 is the worker's own; terse@1 from the profile; terse@3 is not in the library: the resolution reports it
    expect(spec?.providers).toEqual([{ id: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434", prices: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } }]);
    expect(JSON.stringify(spec)).not.toMatch(/key|tested|models/i);
  });
});
