import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ADR-0005 addition (2026-10-12): the researcher's beliefs-versus-truth data goes one way, worker → researcher section.
// Nothing that sends to the worker (the client's command and send paths, the run controller, the palette commands) or
// builds run inputs may refer to it; the allowed list is its definition, its one consumer and the worker side.
const NEEDLE = /researcherData|ResearcherData|researcher-data|SimResearcherData|researcherWatch|ResearcherSection/;
const ALLOWED = new Set(
  [
    ["apps", "lab", "src", "panels", "researcher-data.ts"],
    ["apps", "lab", "src", "panels", "researcher-section.tsx"],
    // The Strategy test: a result planned on the ground truth carries the researcher brand; its request carries none.
    ["apps", "lab", "src", "panels", "strategy-test-section.tsx"],
    ["apps", "lab", "src", "panels", "inspector-panel.tsx"],
    ["apps", "lab", "src", "sim", "sim-host.ts"],
    ["apps", "lab", "src", "sim", "hosted-world.ts"],
    // `send` is typed to the two panel-stream requests (`view`, `researcherWatch`): the request, never the data.
    ["apps", "lab", "src", "sim", "sim-client.ts"],
    ["packages", "core", "src", "worker-protocol", "messages.ts"],
    ["packages", "core", "src", "index.ts"],
  ].map((p) => p.join(sep)),
);
const SKIP = new Set(["node_modules", "dist", "coverage", "e2e", "bench"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(name)) sources(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|bench)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("researcher data stays one-way (ADR-0005 addition of 2026-10-12)", () => {
  const root = join(import.meta.dirname, "..", "..");
  const files = [...sources(join(root, "packages")), ...sources(join(root, "apps"))];
  const users = files.filter((f) => NEEDLE.test(code(readFileSync(f, "utf8")))).map((f) => relative(root, f));

  it("only its definition, its section and the worker side refer to it; the command, input and run-start code does not", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(users.filter((f) => !ALLOWED.has(f))).toEqual([]);
    expect(users.length).toBe(ALLOWED.size); // the allow list is not stale
    for (const never of ["commands.ts", "run-controller.ts", "app.tsx", "scene-panel.tsx"]) expect(users.some((u) => u.endsWith(never)), never).toBe(false);
  });

  it("the client's `command` path (the only way to a run input) never touches the observer types", () => {
    const client = code(readFileSync(join(root, "apps", "lab", "src", "sim", "sim-client.ts"), "utf8"));
    const command = client.slice(client.indexOf("command(agentId"), client.indexOf("command(agentId") + 400);
    expect(command).not.toMatch(NEEDLE);
    // The Strategy test's request (`strategyTest`, a one-shot with its own id) carries a target, a map name and a strategy: never the
    // answer's data, and the answer is branded where it is shown (strategy-test-section.tsx).
    const test = client.slice(client.indexOf("strategyTest("), client.indexOf("strategyTest(") + 500);
    expect(test).not.toMatch(NEEDLE);
    expect(client).toMatch(/strategyTest\(req: Omit<SimStrategyTestMessage, "type" \| "requestId">\): Promise<SimStrategyTestResultMessage>/);
    // `send` accepts only the two stream requests, which carry an agent ID and nothing else.
    expect(client).toMatch(/send\(m: Extract<MainToSim, \{ type: "view" \| "researcherWatch" \| "beliefWatch" \| "overlayWatch" \}>\)/);
  });
  // The Scene's difference mode (belief against ground truth, computed on the GPU from the two atlases) is researcher-only too:
  // marked in the Scene, and its code is in the scene modules only: never in the client, the commands, the run controller or
  // anything that sends to the worker.
  it("the Scene's difference mode lives in the scene modules and the panel that shows it, nowhere that sends", () => {
    const DIFF = /["']difference["']|BeliefViewMode|setBeliefMode|MapOverlay/;
    const allowed = new Set(
      [
        ["apps", "lab", "src", "panels", "scene-panel.tsx"],
        ["apps", "lab", "src", "panels", "use-belief-overlay.ts"],
        // The scenario editor draws a prior against the world with the same overlay (an authoring view; marked the same way).
        ["apps", "lab", "src", "panels", "scenario-editor", "editor-view.ts"],
        ["apps", "lab", "src", "panels", "scenario-editor", "scenario-editor-panel.tsx"],
        ["packages", "ui", "src", "index.ts"],
        ["packages", "ui", "src", "scene", "belief-atlas.ts"],
        ["packages", "ui", "src", "scene", "scene-renderer.ts"],
      ].map((p) => p.join(sep)),
    );
    const diffUsers = files.filter((f) => DIFF.test(code(readFileSync(f, "utf8")))).map((f) => relative(root, f));
    expect(diffUsers.filter((f) => !allowed.has(f))).toEqual([]);
    expect(diffUsers.length).toBe(allowed.size);
    for (const never of ["sim-client.ts", "commands.ts", "run-controller.ts", "app.tsx", "sim-host.ts", "hosted-world.ts", "messages.ts"]) expect(diffUsers.some((u) => u.endsWith(never)), never).toBe(false);
  });
});
