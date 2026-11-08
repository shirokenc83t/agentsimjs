import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_TEMPLATE, MIND_DEFAULTS, documentHash, resolveS2, validateMindProfile, validatePromptTemplate, type S2Profile } from "./documents.ts";

// The mind documents (ADR-0036 and its F4 addition): an `s2` profile and a prompt template, validated with stable codes, resolved over the defaults field by field, hashed from their canonical form.

const profile = (extra: Record<string, unknown> = {}): unknown => ({
  schemaVersion: 1,
  kind: "mind-profile",
  shape: "s2",
  s2: { provider: "local-ollama", model: "llama3.1:8b", promptTemplate: { id: "default", version: 1 }, ...extra },
});

describe("a mind profile", () => {
  it("is valid with a provider, a model and a template, and every other field has the default of the ADR", () => {
    const r = validateMindProfile(profile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const eff = resolveS2(r.value.s2, undefined);
    expect(eff.limits).toEqual({ calls: 20, tokens: 40_000, costUsd: 0.05, timeoutS: 60, retries: 1 });
    expect(eff.tools).toEqual({ maxCallsPerDecision: 8 });
    expect(eff.context).toEqual({ decisions: 5 });
    expect(eff.latency).toEqual({ model: "measured" });
    expect(eff.sources["limits.calls"]).toBe("default");
    expect(eff.sources["model"]).toBe("profile");
  });

  it("refuses each limit outside its range with limit_out_of_range, naming the field", () => {
    const bad: [string, unknown][] = [
      ["limits.calls", { limits: { calls: 0 } }],
      ["limits.calls", { limits: { calls: 100_001 } }],
      ["limits.tokens", { limits: { tokens: 999 } }],
      ["limits.costUsd", { limits: { costUsd: -1 } }],
      ["limits.costUsd", { limits: { costUsd: 1001 } }],
      ["limits.timeoutS", { limits: { timeoutS: 4 } }],
      ["limits.timeoutS", { limits: { timeoutS: 601 } }],
      ["limits.retries", { limits: { retries: 4 } }],
      ["limits.retries", { limits: { retries: -1 } }],
      ["context.decisions", { context: { decisions: 51 } }],
      ["tools.maxCallsPerDecision", { tools: { maxCallsPerDecision: 17 } }],
    ];
    for (const [path, extra] of bad) {
      const r = validateMindProfile(profile(extra as Record<string, unknown>));
      expect(r.ok, path).toBe(false);
      if (!r.ok) {
        expect(r.error.code, path).toBe("limit_out_of_range");
        expect(r.error.path, path).toBe(path);
      }
    }
    // The edges are in.
    expect(validateMindProfile(profile({ limits: { calls: 1, tokens: 1000, costUsd: 0, timeoutS: 5, retries: 0 }, context: { decisions: 0 }, tools: { maxCallsPerDecision: 0 } })).ok).toBe(true);
    expect(validateMindProfile(profile({ limits: { calls: 100_000, tokens: 100_000_000, costUsd: 1000, timeoutS: 600, retries: 3 }, context: { decisions: 50 }, tools: { maxCallsPerDecision: 16 } })).ok).toBe(true);
  });

  it("refuses a document that is not a profile, a shape that is not built, and fields it does not know", () => {
    expect(validateMindProfile({ schemaVersion: 1, kind: "mind-profile", shape: "s1", s1: {} })).toMatchObject({ ok: false, error: { code: "mind_shape_mismatch" } });
    expect(validateMindProfile(profile({ surprise: 1 }))).toMatchObject({ ok: false, error: { code: "invalid_document" } });
    expect(validateMindProfile({ schemaVersion: 1, kind: "other" })).toMatchObject({ ok: false, error: { code: "invalid_document" } });
    expect(validateMindProfile(null)).toMatchObject({ ok: false, error: { code: "invalid_document" } });
    expect(validateMindProfile(profile({ tools: { allow: ["goTo", "goTo"] } }))).toMatchObject({ ok: false, error: { code: "invalid_document" } });
  });

  it("is resolved field by field: an override beats the profile and the profile beats the default, and each field says where it came from", () => {
    const s2 = (validateMindProfile(profile({ params: { temperature: 0.2 }, limits: { calls: 50 } })) as { ok: true; value: { s2: S2Profile } }).value.s2;
    const eff = resolveS2(s2, { model: "qwen2.5:7b", params: { topP: 0.9 }, limits: { calls: 7, retries: 2 } });
    expect(eff.model).toBe("qwen2.5:7b");
    expect(eff.params).toEqual({ temperature: 0.2, topP: 0.9 });
    expect(eff.limits).toEqual({ calls: 7, tokens: 40_000, costUsd: 0.05, timeoutS: 60, retries: 2 });
    expect(eff.sources).toMatchObject({ model: "override", "params.temperature": "profile", "params.topP": "override", "limits.calls": "override", "limits.tokens": "default", "limits.retries": "override", provider: "profile" });
  });
});

describe("a prompt template", () => {
  it("has a system text and the order of the named slots the builder fills, with an instruction per slot if wanted", () => {
    const r = validatePromptTemplate({ schemaVersion: 1, kind: "prompt-template", system: "You fly a UAV.", sections: ["role", "mission", "events", "actions"], instructions: { actions: "Pick one." } });
    expect(r.ok).toBe(true);
    expect(validatePromptTemplate(DEFAULT_PROMPT_TEMPLATE).ok).toBe(true);
  });

  it("refuses a slot that is not one of the fixed set, and text that looks like an expression, with template_slot_unknown", () => {
    const base = { schemaVersion: 1, kind: "prompt-template", system: "x", sections: ["role"] };
    expect(validatePromptTemplate({ ...base, sections: ["role", "weather"] })).toMatchObject({ ok: false, error: { code: "template_slot_unknown", path: "sections/1" } });
    for (const text of ["Hello {{mission}}", "cost ${price}", "{% if x %}", "<% code %>", "{#comment#}"]) {
      expect(validatePromptTemplate({ ...base, system: text }), text).toMatchObject({ ok: false, error: { code: "template_slot_unknown", path: "system" } });
    }
    expect(validatePromptTemplate({ ...base, instructions: { role: "use {{x}}" } })).toMatchObject({ ok: false, error: { code: "template_slot_unknown", path: "instructions/role" } });
    expect(validatePromptTemplate({ ...base, instructions: { weather: "x" } })).toMatchObject({ ok: false, error: { code: "template_slot_unknown", path: "instructions/weather" } });
    expect(validatePromptTemplate({ ...base, sections: ["role", "role"] })).toMatchObject({ ok: false, error: { code: "invalid_document" } });
  });
});

describe("the hash of a document", () => {
  it("is the same whatever the order of the keys and changes with any content", () => {
    const a = profile({ params: { temperature: 0.2, topP: 0.9 } });
    const b = { s2: { promptTemplate: { version: 1, id: "default" }, model: "llama3.1:8b", provider: "local-ollama", params: { topP: 0.9, temperature: 0.2 } }, shape: "s2", kind: "mind-profile", schemaVersion: 1 };
    expect(documentHash(a)).toBe(documentHash(b));
    expect(documentHash(a)).not.toBe(documentHash(profile({ params: { temperature: 0.3, topP: 0.9 } })));
    expect(documentHash(a)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("the defaults are the ones of the ADR (a change of one is a change of the hash of every run that leaves it out)", () => {
    expect(MIND_DEFAULTS).toEqual({ limits: { calls: 20, tokens: 40_000, costUsd: 0.05, timeoutS: 60, retries: 1 }, tools: { maxCallsPerDecision: 8 }, context: { decisions: 5 }, latency: { model: "measured" } });
  });
});
