import { DEFAULT_PROMPT_TEMPLATE } from "@agentsim/minds";
import { f1DemoRunConfig, f1DemoScenario, scenarioAgents, type RunConfigDocument } from "@agentsim/scenarios";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { validateDraft } from "./model.ts";
import { withS2 } from "./minds-model.ts";
import { MindsSection } from "./minds-section.tsx";
import type { MissionAgent } from "./mission-section.tsx";
import type { MindLibraryView } from "./use-mind-library.ts";

// The minds table (F4 M4, T-125): an error is on the row it belongs to, and what the table shows as effective is what the resolution of the run configuration gives, the worker's `config` record.

const VERSION = 4;
const view = scenarioAgents(f1DemoScenario());
const agents = view.agents.filter((a) => a.key !== undefined) as unknown as MissionAgent[];
const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local-ollama", model: "qwen2.5:7b", promptTemplate: { id: "default", version: 1 }, limits: { calls: 12 } } };
const library = { profile: (id: string, v: number) => (id === "scout-llm" && v === 1 ? PROFILE : undefined), template: (id: string, v: number) => (id === "default" && v === 1 ? DEFAULT_PROMPT_TEMPLATE : undefined) } as never;
const providers = (id: string) => (id === "local-ollama" ? { kind: "openai-compatible", baseUrl: "http://localhost:11434" } : undefined);
const libView: MindLibraryView = { library, providers: providers as never, profiles: [{ id: "scout-llm", versions: [1] }], templates: [], loaded: true };

const draftFor = (key: string, profile: { id: string; version: number }): RunConfigDocument => withS2(f1DemoRunConfig(VERSION), key, { profile, mission: "Inspect P1 (20, 40) then land." } as never);

describe("the minds table", () => {
  it("puts the error of a profile that does not exist on the row of its agent and on no other", () => {
    const key = agents[0]?.key as string;
    const draft = draftFor(key, { id: "nothing", version: 1 });
    const validation = validateDraft(draft, view, VERSION, { library, providers: providers as never });
    expect(validation.ok).toBe(false);
    render(<MindsSection draft={draft} onChange={() => undefined} agents={agents} validation={validation} library={libView} />);
    expect(screen.getByTestId(`rc-minds-error-${key}`).textContent).toMatch(/✕ \w+:/);
    expect(screen.queryAllByTestId(/^rc-minds-error-/)).toHaveLength(1);
    expect(screen.getByTestId("rc-status-minds").textContent).toBe("✕");
  });

  it("shows the effective configuration the resolution gives, with the override, and the estimate set against its limits", () => {
    const key = agents[0]?.key as string;
    const base = draftFor(key, { id: "scout-llm", version: 1 });
    const entry = base.minds?.byAgent?.[key]?.s2 as object;
    const draft = withS2(base, key, { ...entry, overrides: { limits: { tokens: 60000 } } } as never);
    const validation = validateDraft(draft, view, VERSION, { library, providers: providers as never });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const s2 = validation.resolved.agents.find((a) => a.s2 !== undefined)?.s2;
    expect(s2?.effective.limits).toMatchObject({ calls: 12, tokens: 60000 });
    render(<MindsSection draft={draft} onChange={() => undefined} agents={agents} validation={validation} library={libView} />);
    const text = screen.getByTestId(`rc-minds-effective-${key}`).textContent ?? "";
    expect(text).toContain("qwen2.5:7b");
    expect(text).toContain("12 calls");
    expect(text.replace(/\s/g, "")).toContain("60000tok");
    expect(screen.getByTestId(`rc-minds-est-calls-${key}`).textContent).toBe("5–9 of 12");
    expect(screen.getByTestId("rc-status-minds").textContent).toBe("✓");
  });
});
