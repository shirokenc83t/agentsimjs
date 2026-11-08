import { createMemoryPorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { diffDocs, flatten, listItems, profileLines, storeOf, summaryOf, usedBy, versionsOf } from "./library-model.ts";

// The library of profiles and templates as the panel reads it (F4 M4, T-124): the list, the versions of an item, the diff of two versions, what a version is used by, and a profile as the words of its table.

const profile = (model: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local-ollama", model, promptTemplate: { id: "inspect", version: 2 }, params: { temperature: 0.2 }, limits: { calls: 20, tokens: 40000, costUsd: 0.05, retries: 1 }, tools: { allow: ["planPath", "estimateCost"], maxCallsPerDecision: 8 }, context: { decisions: 3 }, ...extra } });
const template = { schemaVersion: 1, kind: "prompt-template", system: "You are a mind.", sections: ["role", "actions"] };

async function filled() {
  const ports = createMemoryPorts();
  await ports.mindProfiles.saveVersion({ id: "scout-llm", name: "Scout", document: profile("llama3.1:8b") });
  await ports.mindProfiles.saveVersion({ id: "scout-llm", name: "Scout", document: profile("qwen2.5:7b", { tools: { allow: ["planPath", "estimateCost", "querySpace"], maxCallsPerDecision: 8 } }) });
  await ports.mindProfiles.saveVersion({ id: "other", name: "Other", document: profile("m", { provider: undefined }) });
  await ports.promptTemplates.saveVersion({ id: "inspect", name: "inspect", document: template });
  await ports.promptTemplates.saveVersion({ id: "inspect", name: "inspect", document: { ...template, sections: ["role", "mission", "actions"] } });
  return ports;
}

describe("the list and the versions", () => {
  it("lists the items with their latest version and a line about it, and keeps every version of one, oldest first", async () => {
    const ports = await filled();
    const profiles = await listItems(ports, "profile");
    expect(profiles.map((p) => [p.id, p.latestVersion, p.summary])).toEqual([["other", 1, "s2"], ["scout-llm", 2, "s2 · local-ollama"]].map((r) => r as never));
    const templates = await listItems(ports, "template");
    expect(templates.map((t) => [t.id, t.latestVersion, t.summary])).toEqual([["inspect", 2, "3 slots"]]);
    const vs = await versionsOf(storeOf(ports, "profile"), "scout-llm", 2);
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    expect(summaryOf("template", template)).toBe("2 slots");
  });
});

describe("the diff of two versions", () => {
  it("shows what changed (a field, a list), what was added and what was removed, and keeps the rest as same", async () => {
    const ports = await filled();
    const [v1, v2] = await versionsOf(storeOf(ports, "profile"), "scout-llm", 2);
    const d = diffDocs(v1?.document, v2?.document);
    const by = Object.fromEntries(d.map((l) => [l.path, l]));
    expect(by["s2.model"]).toEqual({ path: "s2.model", change: "changed", before: '"llama3.1:8b"', after: '"qwen2.5:7b"' });
    expect(by["s2.tools.allow"]?.change).toBe("changed");
    expect(by["s2.provider"]?.change).toBe("same");
    expect(diffDocs({ a: 1 }, { a: 1, b: 2 }).find((l) => l.path === "b")?.change).toBe("added");
    expect(diffDocs({ a: 1, b: 2 }, { a: 1 }).find((l) => l.path === "b")).toEqual({ path: "b", change: "removed", before: "2" });
    expect([...flatten({ x: { y: [1, 2], z: {} } })]).toEqual([["x.y", "[1,2]"], ["x.z", "{}"]]);
  });
});

describe("what a version is used by", () => {
  it("names the runs and the configurations that use a version of a profile, and for a template the profiles that name it", async () => {
    const ports = await filled();
    const config = { schemaVersion: 0, scenario: { id: "s", version: 1 }, minds: { byAgent: { scout: { s2: { profile: { id: "scout-llm", version: 2 }, mission: "go" } } } } };
    await ports.runs.create({ runId: "run-000012", schemaVersion: 0, createdAtWallMs: 1, label: "r", status: "completed", runConfig: config });
    await ports.runs.create({ runId: "run-000013", schemaVersion: 0, createdAtWallMs: 1, label: "r2", status: "completed" });
    await ports.runConfigs.saveVersion({ id: "f2-inspect", name: "f2-inspect", document: config });
    const p2 = await usedBy(ports, "profile", "scout-llm", 2);
    expect(p2).toEqual({ runs: ["run-000012"], configurations: ["f2-inspect v1"], profiles: [] });
    expect(await usedBy(ports, "profile", "scout-llm", 1)).toEqual({ runs: [], configurations: [], profiles: [] });
    const t2 = await usedBy(ports, "template", "inspect", 2);
    expect(t2.profiles).toEqual(["other v1", "scout-llm v1", "scout-llm v2"]);
    expect(t2.runs).toEqual(["run-000012"]); // through the profile the run used
  });
});

describe("a profile as the words of its table", () => {
  it("writes one line per field, the defaults in words where the profile leaves a field out", async () => {
    const lines = Object.fromEntries(profileLines(profile("qwen2.5:7b")).map((l) => [l.label, l.value]));
    expect(lines).toMatchObject({ provider: "local-ollama", model: "qwen2.5:7b", template: "inspect v2", temperature: "0.2", tools: "planPath, estimateCost", retries: "1", "last N": "3 decisions", latency: "measured" });
    expect(lines["limits"]).toBe("20 calls · 40000 tok · 0.05 USD");
    const bare = Object.fromEntries(profileLines({ s2: { provider: "p", model: "m", promptTemplate: { id: "default", version: 1 } } }).map((l) => [l.label, l.value]));
    expect(bare["limits"]).toContain("defaults");
    expect(bare["tools"]).toBe("all of them");
  });
});
