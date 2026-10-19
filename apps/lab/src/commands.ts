import { useUiContext, type Command } from "@agentsim/ui";
import type { PresetId } from "@agentsim/core";
import type { RunSource } from "./sim/run-source.ts";

/**
 * Researcher commands on one agent (ADR-0015 addition of 2026-10-12): the closed set the worker accepts besides
 * `goTo`, which needs a target and keeps its Scene gesture ("Send to…"). Shared by the Inspector buttons and the
 * command palette so both send exactly the same message. Parameters are the capability's (tools-schema); only
 * defaults are chosen here.
 */
export interface AgentCommand {
  readonly op: "takeoff" | "land" | "explore" | "hold";
  readonly title: string;
}

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  { op: "takeoff", title: "Takeoff" },
  { op: "land", title: "Land" },
  { op: "explore", title: "Explore" },
  { op: "hold", title: "Hold" },
];

/** The effective body parameters of an agent in the loaded run (from the worker's `loaded` message), if any. */
export function agentBody(run: { readonly agents: readonly { readonly id: string; readonly config?: unknown }[] } | undefined, id: string): Record<string, unknown> | undefined {
  const cfg = run?.agents.find((a) => a.id === id)?.config as { body?: Record<string, unknown> } | undefined;
  return cfg?.body;
}

/** Parameters for `op` on an agent with this body: takeoff climbs to the body's cruise altitude unless told otherwise. */
export function commandParams(op: AgentCommand["op"], body: Readonly<Record<string, unknown>> | undefined, altitudeM?: number): Record<string, number> | undefined {
  if (op !== "takeoff") return undefined;
  const cruise = body?.["cruiseAltitudeM"];
  return { altitudeM: altitudeM ?? (typeof cruise === "number" && cruise > 0 ? cruise : 10) };
}

/**
 * Palette entries for the agent selected in the UI context when the palette opens: world scope, so a command the agent
 * cannot run now is refused with its code (shown in the Inspector), not hidden.
 */
export function agentPaletteCommands(source: RunSource, hasRun: boolean, startPreset: (preset: PresetId) => void, busy: boolean): Command[] {
  const sel = useUiContext.getState().selection;
  const id = sel?.kind === "agent" ? sel.id : undefined;
  return AGENT_COMMANDS.map((c) => ({
    id: `agent.${c.op}`,
    title: `${c.title} selected agent${id ? ` (${id})` : ""}`,
    group: "Agent",
    disabled: !id || !hasRun || source.unavailable("commands") !== undefined,
    run: () => id && source.command(id, c.op, commandParams(c.op, agentBody(source.snapshot().run, id))),
  })).concat([
    { id: "run.f2discovery", title: "Load F2 discovery demo (new run, unknown maps)", group: "Run", disabled: busy, run: () => startPreset("f2-discovery") },
    { id: "run.f2prior", title: "Load F2 prior map demo (new run, 1 km², stale survey)", group: "Run", disabled: busy, run: () => startPreset("f2-prior-1km") },
    { id: "run.f2agents", title: "Load F2 20 agents demo (new run, 180-ray lidar)", group: "Run", disabled: busy, run: () => startPreset("f2-20-agents") },
  ]);
}
