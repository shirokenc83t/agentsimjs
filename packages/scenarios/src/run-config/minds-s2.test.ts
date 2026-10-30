import { DEFAULT_PROMPT_TEMPLATE, type MindProfileDocument, type PromptTemplateDocument } from "@agentsim/minds";
import { describe, expect, it } from "vitest";
import { loadScenario, type LoadedScenario } from "../load.ts";
import type { AgentSpec, ScenarioDocument } from "../schema.ts";
import { canonicalRunConfig, parseRunConfigValue, resolveRunConfig, type MindLibrary, type ResolveOptions } from "./resolve.ts";
import type { RunConfigDocument } from "./schema.ts";

// F4 M1 (ADR-0036 and its addition of 2026-10-29): `s2` entries in the run configuration, resolved over the library and the providers, field by field, hashed without a key, with the run mode out of both hashes.

const agents: AgentSpec[] = [
  { kind: "uav", key: "scout", start: { xM: 5, yM: 5, zM: 20 } },
  { kind: "ugv", key: "rover", start: { xM: 6, yM: 6 } },
];
const scenario: ScenarioDocument = {
  schemaVersion: 0,
  id: "planners",
  name: "Planners",
  defaultSeed: 11,
  world: { resolutionM: 1, sizeCells: { x: 128, y: 128 }, chunkSize: 32, altitudeLimitsM: { min: 0, max: 60 }, layers: { occupancy: { chunks: [{ ci: 1, cj: 1, fill: 1 }] } } },
  zones: [],
  agents,
};
function loaded(): LoadedScenario {
  const r = loadScenario(scenario);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const profile = (extra: Record<string, unknown> = {}): MindProfileDocument =>
  ({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local-ollama", model: "llama3.1:8b", promptTemplate: { id: "default", version: 1 }, ...extra } }) as MindProfileDocument;

function library(profiles: Record<string, MindProfileDocument> = { "scout-llm@1": profile() }, templates: Record<string, PromptTemplateDocument> = { "default@1": DEFAULT_PROMPT_TEMPLATE }): MindLibrary {
  return { profile: (id, version) => profiles[`${id}@${version}`], template: (id, version) => templates[`${id}@${version}`] };
}

const options = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  library: library(),
  providers: (id) => (id === "local-ollama" ? { kind: "openai-compatible", baseUrl: "http://localhost:11434" } : undefined),
  ...over,
});

const doc = (minds: unknown, extra: Record<string, unknown> = {}): RunConfigDocument => ({ schemaVersion: 0, scenario: { id: "planners", version: 3 }, minds, ...extra }) as unknown as RunConfigDocument;
const ref = { profile: { id: "scout-llm", version: 1 } };

/** As the lab does it: the document is parsed (the schema), then resolved. */
function resolve(d: RunConfigDocument, opts: ResolveOptions = options()) {
  const parsed = parseRunConfigValue(d);
  if (!parsed.ok) return parsed;
  return resolveRunConfig(parsed.value, { loaded: loaded(), version: 3 }, opts);
}
function good(d: RunConfigDocument, opts: ResolveOptions = options()) {
  const r = resolve(d, opts);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const code = (d: RunConfigDocument, opts: ResolveOptions = options()) => {
  const r = resolve(d, opts);
  return r.ok ? "ok" : r.error.code;
};

describe("an s2 entry of the run configuration", () => {
  it("gives an agent the effective mind of its profile and template, with the mission, the provider's kind and host, and the level that supplied each field", () => {
    const r = good(doc({ byAgent: { scout: { s2: { ...ref, mission: "Inspect the three points and come back." } } } }));
    const scout = r.agents.find((a) => a.key === "scout");
    expect(scout?.s2).toMatchObject({
      source: "byAgent",
      profileRef: { id: "scout-llm", version: 1 },
      provider: { id: "local-ollama", kind: "openai-compatible", host: "localhost:11434" },
      mission: "Inspect the three points and come back.",
      effective: { model: "llama3.1:8b", limits: { calls: 20, tokens: 40_000, costUsd: 0.05, timeoutS: 60, retries: 1 } },
    });
    expect(scout?.s2?.template).toMatchObject({ id: "default", version: 1 });
    expect(scout?.s2?.sources["limits.calls"]).toBe("default");
    expect(scout?.s2?.sources["model"]).toBe("profile");
    expect(r.agents.find((a) => a.key === "rover")?.s2).toBeUndefined();
  });

  it("takes the entry of the most specific level, and an override changes one field and says so", () => {
    const d = doc({ default: { s2: { ...ref } }, byKind: { uav: { s2: { ...ref, overrides: { model: "qwen2.5:7b" } } } }, byAgent: { rover: { s2: { ...ref, overrides: { limits: { calls: 5 } } } } } });
    const r = good(d);
    const scout = r.agents.find((a) => a.key === "scout")?.s2;
    const rover = r.agents.find((a) => a.key === "rover")?.s2;
    expect([scout?.source, scout?.effective.model, scout?.sources["model"]]).toEqual(["byKind", "qwen2.5:7b", "override"]);
    expect([rover?.source, rover?.effective.model, rover?.effective.limits.calls, rover?.sources["limits.calls"]]).toEqual(["byAgent", "llama3.1:8b", 5, "override"]);
  });

  it("accepts an inline profile in place of a library reference", () => {
    const inline = (profile() as { s2: unknown }).s2;
    const r = good(doc({ default: { s2: { profile: inline } } }), options({ library: library({}, { "default@1": DEFAULT_PROMPT_TEMPLATE }) }));
    expect(r.agents[0]?.s2?.profileRef).toBeUndefined();
    expect(r.agents[0]?.s2?.effective.model).toBe("llama3.1:8b");
  });

  it("is refused with a stable code for everything that cannot be resolved", () => {
    expect(code(doc({ byAgent: { scout: { s2: { profile: { id: "ghost", version: 1 } } } } }))).toBe("mind_profile_not_found");
    expect(code(doc({ byAgent: { scout: { s2: { ...ref } } } }), options({ library: library({ "scout-llm@1": profile() }, {}) }))).toBe("prompt_template_not_found");
    expect(code(doc({ byAgent: { scout: { s2: { ...ref } } } }), options({ providers: () => undefined }))).toBe("provider_not_configured");
    expect(code(doc({ byAgent: { scout: { s2: { ...ref } } } }), { library: library() })).toBe("provider_not_configured");
    expect(code(doc({ byAgent: { scout: { s2: { ...ref }, s1: { script: { name: "sequence", params: { steps: [{ action: "hold" }] } } } } } }))).toBe("mind_shape_mismatch");
    expect(code(doc({ byAgent: { scout: { s2: { ...ref, overrides: { limits: { retries: 4 } } } } } }))).toBe("limit_out_of_range");
    expect(code(doc({ byAgent: { scout: { s2: { ...ref, mission: "x".repeat(2001) } } } }))).toBe("invalid_document");
    expect(code(doc({ byAgent: { nobody: { s2: { ...ref } } } }))).toBe("unknown_agent_key");
    expect(code(doc({ byAgent: { scout: {} } }))).toBe("invalid_document");
  });
});

describe("the hashes", () => {
  const base = () => doc({ byAgent: { scout: { s2: { ...ref, mission: "go" } } } });

  it("runConfigHash counts a library reference by id and version and does not change when the document is resolved; effectiveConfigHash changes with the content, the template, the model, the mission and the provider's host", () => {
    const a = good(base());
    expect(good(base()).runConfigHash).toBe(a.runConfigHash);
    const changed = (opts: ResolveOptions, d = base()) => good(d, opts).effectiveConfigHash;
    expect(changed(options({ library: library({ "scout-llm@1": profile({ limits: { calls: 21 } }) }) }))).not.toBe(a.effectiveConfigHash);
    expect(changed(options({ library: library({ "scout-llm@1": profile({ model: "other" }) }) }))).not.toBe(a.effectiveConfigHash);
    expect(changed(options({ library: library(undefined, { "default@1": { ...DEFAULT_PROMPT_TEMPLATE, system: "Different words." } }) }))).not.toBe(a.effectiveConfigHash);
    expect(changed(options({ providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:8000" }) }))).not.toBe(a.effectiveConfigHash);
    expect(changed(options(), doc({ byAgent: { scout: { s2: { ...ref, mission: "stay" } } } }))).not.toBe(a.effectiveConfigHash);
    // ... while the same content under another library version number, or another provider id for the same endpoint, is the same mind.
    expect(changed(options({ library: library({ "scout-llm@1": profile() }) }))).toBe(a.effectiveConfigHash);
    // Another reference changes the run configuration's hash.
    expect(good(doc({ byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 1 }, mission: "stay" } } } })).runConfigHash).not.toBe(a.runConfigHash);
  });

  it("mindsRunMode is in neither hash: it says where responses come from, not what the minds decide", () => {
    const live = good(base());
    for (const mode of ["live", "replay-strict", "replay-then-live"]) {
      const r = good({ ...base(), mindsRunMode: mode } as RunConfigDocument);
      expect(r.runConfigHash, mode).toBe(live.runConfigHash);
      expect(r.effectiveConfigHash, mode).toBe(live.effectiveConfigHash);
      expect(r.mindsRunMode).toBe(mode);
    }
    expect(live.mindsRunMode).toBe("live");
    expect(canonicalRunConfig({ ...base(), mindsRunMode: "replay-strict" } as RunConfigDocument)).not.toContain("mindsRunMode");
    expect(resolve({ ...base(), mindsRunMode: "sometimes" } as unknown as RunConfigDocument).ok).toBe(false);
  });

  it("holds no key and no price: a provider entry with both gives the same hashes and a resolved configuration with neither", () => {
    const secret = "sk-test-PLANTED-0123456789";
    const withSecrets = options({ providers: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:11434", key: secret, prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } }) as never });
    const plain = good(base());
    const r = good(base(), withSecrets);
    expect(r.effectiveConfigHash).toBe(plain.effectiveConfigHash);
    expect(r.runConfigHash).toBe(plain.runConfigHash);
    const text = JSON.stringify(r);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("inputUsdPerMTok");
    expect(text).not.toContain("apiKey");
  });

  it("leaves the F3c configurations alone: a mission of the s1 shape hashes as before (pinned from the code of F3c)", () => {
    const mission = doc({ byAgent: { scout: { s1: { script: { name: "sequence", params: { steps: [{ action: "takeoff", args: { altitudeM: 20 } }, { action: "hold", args: { durationS: 3 } }] } } } } } });
    const r = good(mission, {});
    expect([r.runConfigHash, r.effectiveConfigHash]).toEqual(["7ccc5de3", "a648060d"]);
    expect(good(doc({}), {}).agents.every((a) => a.s2 === undefined)).toBe(true);
  });
});
