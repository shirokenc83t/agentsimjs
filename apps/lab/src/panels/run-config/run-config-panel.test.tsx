import type { SimLoadedMessage } from "@agentsim/core";
import { f1DemoRunConfig, f1DemoScenario, scenarioAgents } from "@agentsim/scenarios";
import { createMemoryPorts, type StorageClient } from "@agentsim/storage";
import type { RunHeader } from "@agentsim/trace";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CurrentRunProvider, ServicesProvider, type CurrentRun } from "../../services.tsx";
import type { LabRun } from "../../sim/run-controller.ts";
import type { RunSource } from "../../sim/run-source.ts";
import type { SimClient } from "../../sim/sim-client.ts";
import { validateDraft } from "./model.ts";
import { RunConfigPanel } from "./run-config-panel.tsx";

const VERSION = 4;
const scenario = f1DemoScenario();
const runConfig = f1DemoRunConfig(VERSION);
const initial = validateDraft(runConfig, scenarioAgents(scenario), VERSION);
const initialHash = initial.ok ? initial.resolved.runConfigHash : "";

function labRun(): LabRun {
  const header = { runId: "run-000001", label: "F1 demo", runConfigHash: initialHash } as RunHeader;
  // What the worker reports at load: the panel builds its agents view from this, never from the document.
  const view = scenarioAgents(scenario);
  const loaded = {
    scenarioId: scenario.id,
    scenarioVersion: VERSION,
    defaultSeed: scenario.defaultSeed,
    agents: view.agents.map((a) => ({ id: a.id, ...(a.key === undefined ? {} : { key: a.key }), kind: a.kind, body: a.body })),
  } as SimLoadedMessage;
  // The document is deliberately not usable here: the panel must not parse it.
  return { loaded, header, scenario: undefined, runConfig };
}

function setup(over: Partial<CurrentRun> = {}) {
  const ports = createMemoryPorts();
  const storage = { ports, status: () => ({ state: "ready", mode: "memory-fallback" }), onStatus: () => () => {} } as unknown as StorageClient;
  const runWithConfig = vi.fn();
  const current: CurrentRun = { run: labRun(), busy: false, error: null, loadDemo: vi.fn(), runWithConfig, startScenarioRun: vi.fn(), ...over };
  render(
    <ServicesProvider value={{ storage, sim: {} as SimClient, source: {} as RunSource, setReplaySource: () => {} }}>
      <CurrentRunProvider value={current}>
        <RunConfigPanel />
      </CurrentRunProvider>
    </ServicesProvider>,
  );
  return { ports, runWithConfig };
}

describe("RunConfigPanel (ADR-0028)", () => {
  it("offers to load a scenario when none is loaded", () => {
    setup({ run: undefined });
    expect(screen.getByTestId("run-config-panel")).toHaveTextContent("No scenario loaded");
  });

  it("shows the current run's configuration as valid, with both hashes live", () => {
    setup();
    expect(screen.getByTestId("rc-valid")).toHaveTextContent("✓ valid for 3 agents");
    expect(screen.getByTestId("rc-run-config-hash")).toHaveTextContent(`${initialHash} (= current run)`);
    expect(screen.getByTestId("rc-effective-ugv-001")).toHaveTextContent("distance 1");
  });

  it("sets a terrain-weighted cost profile for one agent and runs with it", async () => {
    const { runWithConfig } = setup();
    const effectiveBefore = screen.getByTestId("rc-effective-config-hash").textContent;
    await userEvent.selectOptions(screen.getByTestId("rc-planning-scope"), "byAgent.rover");
    await userEvent.click(screen.getByTestId("rc-override-profile"));
    await userEvent.type(screen.getByTestId("rc-profile-weight-terrain"), "1");
    expect(screen.getByTestId("rc-profile-ok")).toBeInTheDocument();
    const row = screen.getByTestId("rc-effective-ugv-001");
    expect(row).toHaveTextContent("distance 1, terrain 1");
    expect(within(row).getAllByText("byAgent").length).toBe(1);
    expect(screen.getByTestId("rc-effective-ugv-002")).not.toHaveTextContent("terrain");
    expect(screen.getByTestId("rc-effective-config-hash").textContent).not.toBe(effectiveBefore);
    expect(screen.getByTestId("rc-run-config-hash")).not.toHaveTextContent("(= current run)");

    await userEvent.click(screen.getByTestId("rc-run"));
    expect(runWithConfig).toHaveBeenCalledWith({ ...runConfig, planning: { byAgent: { rover: { costProfile: { weights: { distance: 1, terrain: 1 } } } } } });
  });

  it("sets the exploration scope (ADR-0040): the defaults are in the effective table, a radius for the rover changes its row and the configuration hash", async () => {
    const { runWithConfig } = setup();
    const hashBefore = screen.getByTestId("rc-effective-config-hash").textContent;
    // Built-in placeholders: a ground vehicle explores in iterations of 40 m, an aerial one of 80 m, windows margin 10 m.
    expect(screen.getByTestId("rc-effective-explore-ugv-001")).toHaveTextContent("40 m builtin / 10 m builtin");
    expect(screen.getByTestId("rc-effective-explore-uav-001")).toHaveTextContent("80 m builtin / 10 m builtin");
    expect(screen.getByTestId("rc-explore-radius")).toHaveAttribute("placeholder", "ugv 40 · uav 80");
    await userEvent.selectOptions(screen.getByTestId("rc-planning-scope"), "byAgent.rover");
    await userEvent.type(screen.getByTestId("rc-explore-radius"), "25");
    await userEvent.type(screen.getByTestId("rc-window-margin"), "5");
    expect(screen.getByTestId("rc-effective-explore-ugv-001")).toHaveTextContent("25 m byAgent / 5 m byAgent");
    expect(screen.getByTestId("rc-effective-explore-ugv-002")).toHaveTextContent("40 m builtin");
    expect(screen.getByTestId("rc-effective-config-hash").textContent).not.toBe(hashBefore);
    await userEvent.click(screen.getByTestId("rc-run"));
    expect(runWithConfig).toHaveBeenCalledWith(expect.objectContaining({ planning: { byAgent: { rover: { radiusM: 25, windowMarginM: 5 } } } }));
  });

  it("reports invalid values with their stable codes and does not run them", async () => {
    const { runWithConfig } = setup();
    await userEvent.type(screen.getByTestId("rc-per-tick"), "0");
    expect(screen.getByTestId("rc-error")).toHaveTextContent("budget_out_of_range");
    expect(screen.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByTestId("rc-run"));
    expect(runWithConfig).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByTestId("rc-per-tick"));
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("rc-override-profile"));
    await userEvent.clear(screen.getByTestId("rc-profile-weight-distance"));
    expect(screen.getByTestId("rc-profile-issue")).toHaveTextContent("profile_degenerate");
    expect(screen.getByTestId("rc-error")).toHaveTextContent("profile_degenerate");
  });

  it("marks an invalid constraint inline; code-like input is rejected, never run", async () => {
    setup();
    await userEvent.click(screen.getByTestId("rc-override-profile"));
    await userEvent.click(screen.getByTestId("rc-profile-add-constraint"));
    const input = screen.getByTestId("rc-profile-constraint-0");
    await userEvent.type(input, "fetch(1)");
    expect(screen.getByTestId("rc-profile-constraint-0-issue")).toHaveTextContent("constraint_invalid");
    expect(screen.getByTestId("rc-error")).toHaveTextContent("constraint_invalid");
    await userEvent.clear(input);
    await userEvent.type(input, "slope < 0.5");
    expect(screen.queryByTestId("rc-profile-constraint-0-issue")).toBeNull();
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
  });

  it("applies JSON edits only through the parser", async () => {
    setup();
    const text = screen.getByTestId("rc-json-text");
    await userEvent.clear(text);
    await userEvent.type(text, "{{ not json");
    await userEvent.click(screen.getByTestId("rc-json-apply"));
    expect(screen.getByTestId("rc-json-error")).toHaveTextContent("invalid_json");

    await userEvent.clear(text);
    await userEvent.paste(JSON.stringify({ ...runConfig, seed: 42, planning: { byKind: { ugv: { algorithm: "hpa" } } } }));
    await userEvent.click(screen.getByTestId("rc-json-apply"));
    expect(screen.queryByTestId("rc-json-error")).toBeNull();
    expect(screen.getByTestId("rc-seed")).toHaveValue(42);
    expect(screen.getByTestId("rc-effective-ugv-001")).toHaveTextContent("hpa");
  });

  it("saves the draft as a preset version and loads it back, rebased on the loaded scenario version", async () => {
    const { ports } = setup();
    await ports.runConfigs.saveVersion({ id: "old-seed", name: "Old seed", document: { ...runConfig, scenario: { id: "f1-demo", version: 1 }, seed: 9 } });
    await userEvent.type(screen.getByTestId("rc-seed"), "5");
    await userEvent.type(screen.getByTestId("rc-preset-name"), "Seed five");
    await userEvent.click(screen.getByTestId("rc-preset-save"));
    expect(await screen.findByTestId("rc-preset-msg")).toHaveTextContent("✓ saved seed-five v1");
    expect((await ports.runConfigs.get("seed-five"))?.document).toEqual({ ...runConfig, seed: 5 });

    await waitFor(() => expect(screen.getByTestId("rc-preset-select")).toHaveTextContent("Old seed"));
    await userEvent.selectOptions(screen.getByTestId("rc-preset-select"), "old-seed");
    await userEvent.click(screen.getByTestId("rc-preset-load"));
    await waitFor(() => expect(screen.getByTestId("rc-preset-msg")).toHaveTextContent("applied to v4"));
    expect(screen.getByTestId("rc-seed")).toHaveValue(9);
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
  });
});

describe("RunConfigPanel: a run that starts an agent from a prior map (found with the 1 km² prior demo in F2b M5)", () => {
  it("validates the configuration of the current run: the worker reports each prior's content hash, which the effective-config hash records", () => {
    const base = labRun();
    const runConfigWithPrior = { ...runConfig, beliefs: { default: { init: "unknown" }, byAgent: { rover: { init: { prior: "survey" } } } } };
    const run = { ...base, runConfig: runConfigWithPrior, loaded: { ...base.loaded, priors: ["survey"], priorHashes: { survey: "0f1e2d3c" } } } as unknown as LabRun;
    setup({ run });
    expect(screen.queryByTestId("rc-error")).toBeNull();
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
    expect(screen.getByTestId("rc-effective-init-ugv-001")).toHaveTextContent("prior survey");
  });
});

describe("RunConfigPanel: the planner choice (ADR-0037, F2b M4)", () => {
  const inlineDoc = (root: unknown) => JSON.stringify({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root });
  const astar = { kind: "algorithm", algorithm: "astar" };
  const hpa = { kind: "algorithm", algorithm: "hpa" };

  async function chooseStrategy() {
    await userEvent.selectOptions(screen.getByTestId("rc-planner"), "strategy");
  }

  it("choosing 'strategy' selects a shipped preset, clears the algorithm, and the run is the same document the resolver accepts", async () => {
    const { runWithConfig } = setup();
    await userEvent.selectOptions(screen.getByTestId("rc-algorithm"), "dijkstra");
    await chooseStrategy();
    expect(screen.queryByTestId("rc-algorithm")).toBeNull();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "astar-then-hpa@1");
    expect(screen.getByTestId("rc-strategy-description")).toHaveTextContent("HPA* takes over");
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
    expect(screen.getByTestId("rc-effective-ugv-001")).toHaveTextContent("strategy:astar-then-hpa@1");
    await userEvent.click(screen.getByTestId("rc-run"));
    expect(runWithConfig).toHaveBeenCalledWith({ ...runConfig, planning: { default: { strategy: { ref: "astar-then-hpa", version: 1 } } } });
  });

  it("lists every shipped preset and shows its document read-only", async () => {
    setup();
    await chooseStrategy();
    const options = within(screen.getByTestId("rc-strategy-preset")).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(options).toEqual(["anytime-weighted@1", "astar-only@1", "astar-then-hpa@1", "hpa-only@1", "short-astar-long-hpa@1", "inline"]);
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "short-astar-long-hpa@1");
    expect(screen.getByTestId("rc-strategy-view")).toHaveTextContent("dist.m <= 200");
  });

  it("'Edit as inline' copies the preset into the editor and the draft; the document stays valid", async () => {
    setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "hpa-only@1");
    await userEvent.click(screen.getByTestId("rc-strategy-edit-inline"));
    expect((screen.getByTestId("rc-strategy-json") as HTMLTextAreaElement).value).toContain('"id": "hpa-only"');
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
  });

  it("reports an inline document's problems with the resolver's stable code and path, next to the editor, and disables the run", async () => {
    const { runWithConfig } = setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "inline");
    const text = screen.getByTestId("rc-strategy-json");
    await userEvent.clear(text);
    await userEvent.paste(inlineDoc({ kind: "select", branches: [{ when: "nonsense > 1", then: astar }], else: hpa }));
    expect(screen.getByTestId("rc-strategy-error")).toHaveTextContent("expr_unknown_name");
    expect(screen.getByTestId("rc-strategy-error")).toHaveTextContent("/planning/default/strategy");
    expect(screen.getByTestId("rc-error")).toHaveTextContent("expr_unknown_name");
    expect(screen.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByTestId("rc-run"));
    expect(runWithConfig).not.toHaveBeenCalled();
    // Fixing the document clears both.
    await userEvent.clear(text);
    await userEvent.paste(inlineDoc({ kind: "select", branches: [{ when: "dist.m <= 100", then: astar }], else: hpa }));
    expect(screen.queryByTestId("rc-strategy-error")).toBeNull();
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
  });

  it("broken JSON is invalid_json at the editor and does not touch the draft", async () => {
    setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "inline");
    const before = screen.getByTestId("rc-run-config-hash").textContent;
    const text = screen.getByTestId("rc-strategy-json");
    await userEvent.clear(text);
    await userEvent.paste("{ not json");
    expect(screen.getByTestId("rc-strategy-json-error")).toHaveTextContent("invalid_json");
    expect(screen.getByTestId("rc-run-config-hash").textContent).toBe(before);
  });

  it("malicious inline content is rejected with codes, never run", async () => {
    setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "inline");
    const text = screen.getByTestId("rc-strategy-json");
    await userEvent.clear(text);
    await userEvent.paste(inlineDoc({ kind: "select", branches: [{ when: "constructor.constructor('x')()", then: astar }], else: hpa }));
    expect(screen.getByTestId("rc-strategy-error")).toBeInTheDocument();
    expect(screen.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "true");
  });

  it("warns, without blocking, about a lazy refine on agents that plan on a belief map, naming each agent", async () => {
    const { runWithConfig } = setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "inline");
    const text = screen.getByTestId("rc-strategy-json");
    await userEvent.clear(text);
    await userEvent.paste(inlineDoc({ kind: "refine", mode: "lazy", coarse: hpa, local: astar }));
    // The F1 demo's agents are ideal (they plan on the ground truth): nothing to warn about yet.
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
    expect(screen.queryByTestId("rc-warning-ugv-001")).toBeNull();
    await userEvent.selectOptions(screen.getByTestId("rc-beliefs-init"), "unknown");
    expect(screen.getByTestId("rc-valid")).toBeInTheDocument();
    const w = screen.getByTestId("rc-warning-ugv-001");
    expect(w).toHaveTextContent("▲");
    expect(w).toHaveTextContent("lazy_refine_on_belief_map");
    expect(w).toHaveTextContent(/belief map/);
    expect(screen.getByTestId("rc-run")).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(screen.getByTestId("rc-run"));
    expect(runWithConfig).toHaveBeenCalledTimes(1);
  });

  it("no warning for an eager refine or a preset", async () => {
    setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-strategy-preset"), "inline");
    const text = screen.getByTestId("rc-strategy-json");
    await userEvent.clear(text);
    await userEvent.paste(inlineDoc({ kind: "refine", mode: "eager", coarse: hpa, local: astar }));
    expect(screen.queryByTestId("rc-warning-ugv-001")).toBeNull();
  });

  it("switching back to 'algorithm' removes the strategy from the document", async () => {
    setup();
    await chooseStrategy();
    await userEvent.selectOptions(screen.getByTestId("rc-planner"), "algorithm");
    expect(screen.getByTestId("rc-algorithm")).toBeInTheDocument();
    expect(screen.getByTestId("rc-run-config-hash")).toHaveTextContent("(= current run)");
  });
});
