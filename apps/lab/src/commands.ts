import { useUiContext, type Command } from "@agentsim/ui";
import { commandAvailability, describeUnavailable, STATUS_STRIDE, type AgentFacts, type PresetId } from "@agentsim/core";
import { toolsSchemaCapabilities } from "@agentsim/scenarios";
import type { RunSource } from "./sim/run-source.ts";
import { reflexWords, type ActionView, type CommandView, type ReflexView } from "./panels/agent-views.ts";

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

/**
 * What the start check needs to know of an agent, read from what the panels already have: its kind and effective body (the worker's `loaded` message) and its status (battery,
 * airborne) at the panel cadence. Undefined where there is no status (a source that has none): the controls then rest on `unavailable("commands")` alone.
 */
export function agentFacts(
  run: { readonly agents: readonly { readonly id: string; readonly kind: "ugv" | "uav"; readonly config?: unknown }[] } | undefined,
  status: Float32Array | undefined,
  entityIds: readonly string[],
  id: string,
): AgentFacts | undefined {
  const agent = run?.agents.find((a) => a.id === id);
  const i = entityIds.indexOf(id);
  if (!agent || i < 0 || !status || status.length < (i + 1) * STATUS_STRIDE) return undefined;
  const sensors = (agent.config as { body?: { sensors?: readonly { type?: string }[] } } | undefined)?.body?.sensors ?? [];
  return { kind: agent.kind, airborne: (status[i * STATUS_STRIDE + 3] ?? 0) === 1, soc: status[i * STATUS_STRIDE] ?? 1, hasBase: true, hasRangeSensor: sensors.some((s) => s.type !== "camera") };
}

/**
 * Why a command cannot be given to this agent now, in words and with the step to do first (`Land needs airborne · take off first`), from the same availability check the
 * runtime starts actions by. Undefined when it can.
 */
export function commandHint(op: string, title: string, facts: AgentFacts | undefined): string | undefined {
  if (!facts) return undefined;
  const u = commandAvailability(toolsSchemaCapabilities, op, facts);
  return u ? `${title} ${describeUnavailable(u, facts.kind)}` : undefined;
}

/**
 * Whether a command is one this agent can ever be given: not for its kind of vehicle, or needing something its body does not have (a base, a range sensor). Such a command is not
 * offered at all (the Inspector says so in one line); a condition that can change (airborne, on the ground, the battery) is a hint on a command that is offered. The words are the
 * action's name and why, `Takeoff is not for a ground vehicle`; undefined when it can be given, now or later.
 */
export function commandUnsupported(op: string, title: string, facts: AgentFacts | undefined): string | undefined {
  if (!facts) return undefined;
  const u = commandAvailability(toolsSchemaCapabilities, op, facts);
  if (!u) return undefined;
  const fixed = u.code === "vehicle_unsupported" || (u.code === "precondition_failed" && (u.requires === "hasBase" || u.requires === "hasRangeSensor"));
  return fixed ? `${title} ${describeUnavailable(u, facts.kind)}` : undefined;
}

/** The facts of an agent of the run a source shows, at the panel cadence. */
function factsOf(source: RunSource, id: string): AgentFacts | undefined {
  const s = source.snapshot();
  return agentFacts(s.run, s.agentStatus, s.entityIds, id);
}

/**
 * A warning for the commands of an agent whose battery is at or below its critical level: the runtime accepts a command then (it refuses only an empty battery), and the battery
 * reflex takes the agent over (it is latched: it acts once, as it crosses the level) by sending it back to base. Said before the click, so that the agent going home by itself is
 * not a surprise. Undefined above the level, or when the body does not say its level.
 */
export function batteryWarning(body: Readonly<Record<string, unknown>> | undefined, soc: number | undefined): string | undefined {
  const critical = (body?.["battery"] as { criticalSoc?: unknown } | undefined)?.criticalSoc;
  if (typeof critical !== "number" || soc === undefined || soc > critical || soc <= 0) return undefined;
  return `battery ${(soc * 100).toFixed(1)} % is at or below its critical level (${(critical * 100).toFixed(0)} %): the battery reflex preempts what it is doing and sends it back to base (a UAV without a base lands, a rover holds)`;
}

/** A refused command in words: the missing condition and the step to do first when a precondition did not hold (`land needs airborne · take off first`), else the stable code. */
export function refusalWords(c: { readonly name: string; readonly failure?: string | undefined; readonly requires?: string | undefined }, kind: string | undefined): string {
  if (c.failure === "precondition_failed" && c.requires !== undefined) return `${c.name} ${describeUnavailable({ code: "precondition_failed", message: "", requires: c.requires }, kind ?? "")}`;
  return c.failure ?? "?";
}

/** The effective body parameters of an agent in the loaded run (from the worker's `loaded` message), if any. */
export function agentBody(run: { readonly agents: readonly { readonly id: string; readonly config?: unknown }[] } | undefined, id: string): Record<string, unknown> | undefined {
  const cfg = run?.agents.find((a) => a.id === id)?.config as { body?: Record<string, unknown> } | undefined;
  return cfg?.body;
}

/** The radius of an exploration iteration an agent has by configuration (ADR-0040), from the worker's `loaded` message, if it says. */
export function agentExploreRadius(run: { readonly agents: readonly { readonly id: string; readonly config?: unknown }[] } | undefined, id: string): number | undefined {
  const cfg = run?.agents.find((a) => a.id === id)?.config as { planning?: { radiusM?: unknown } } | undefined;
  const r = cfg?.planning?.radiusM;
  return typeof r === "number" ? r : undefined;
}

/**
 * Parameters for `op` on an agent with this body: takeoff climbs to the body's cruise altitude unless told otherwise; explore takes a
 * radius only when one is given (otherwise the agent's configured radius applies, ADR-0040).
 */
export function commandParams(op: AgentCommand["op"], body: Readonly<Record<string, unknown>> | undefined, altitudeM?: number, radiusM?: number): Record<string, number> | undefined {
  if (op === "explore") return radiusM === undefined ? undefined : { radiusM };
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
    // A command the agent cannot be given now is off, as on the Inspector's button: the same availability check.
    disabled: !id || !hasRun || source.unavailable("commands") !== undefined || (id !== undefined && commandHint(c.op, c.title, factsOf(source, id)) !== undefined),
    run: () => id && source.command(id, c.op, commandParams(c.op, agentBody(source.snapshot().run, id))),
  })).concat([
    { id: "run.f2discovery", title: "Load F2 discovery demo (new run, unknown maps)", group: "Run", disabled: busy, run: () => startPreset("f2-discovery") },
    { id: "run.f2prior", title: "Load F2 prior map demo (new run, 1 km², stale survey)", group: "Run", disabled: busy, run: () => startPreset("f2-prior-1km") },
    { id: "run.f2agents", title: "Load F2 20 agents demo (new run, 180-ray lidar)", group: "Run", disabled: busy, run: () => startPreset("f2-20-agents") },
  ]);
}

/** How long a button says "done" after its action succeeded (ms). */
export const DONE_MS = 4000;

/**
 * The state of an action button of the Inspector, from the action's state in the trace and not from the click (U-010 §1): idle; running (this is the agent's current action,
 * with its phase); done (it succeeded, for `DONE_MS`); refused (the start was rejected, in words, until the next click); preempted (a reflex took over, until the next action).
 * "Armed" (waiting for a map click) belongs to the Scene's send-to control and is its own mode.
 */
export type ButtonState =
  | { readonly state: "idle" }
  | { readonly state: "queued" }
  | { readonly state: "running"; readonly phase: string | undefined }
  | { readonly state: "done" }
  | { readonly state: "refused"; readonly words: string }
  | { readonly state: "preempted"; readonly reflex: string | undefined };

export function commandButtonState(
  op: string,
  v: { readonly action: ActionView | undefined; readonly command: CommandView | undefined; readonly reflex: ReflexView | undefined },
  opts: { readonly doneVisible: boolean; readonly refusalAcked: boolean; readonly kind: string | undefined; readonly queued?: boolean },
): ButtonState {
  const a = v.action;
  if (a !== undefined && a.name === op) {
    if (a.status === "running") return { state: "running", phase: a.phase };
    // Given and not yet applied (the run is paused or waiting to start: a command takes effect at a tick): it is in the queue, whatever this action did the last time.
    if (opts.queued) return { state: "queued" };
    if (a.status === "preempted") return { state: "preempted", reflex: v.reflex === undefined ? undefined : reflexWords(v.reflex.code) };
    if (a.status === "succeeded" && opts.doneVisible) return { state: "done" };
  }
  if (opts.queued) return { state: "queued" };
  const c = v.command;
  if (c !== undefined && !c.ok && c.name === op && !opts.refusalAcked) return { state: "refused", words: refusalWords(c, opts.kind) };
  return { state: "idle" };
}
