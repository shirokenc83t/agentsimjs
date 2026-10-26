import { commandAvailability, describeUnavailable, resumesAfterPreemption, type AgentFacts, type SequenceStep } from "@agentsim/core";
import { toolsSchemaCapabilities, type RunConfigDocument } from "@agentsim/scenarios";

// The model of the mission step editor (F3c M1): the list of steps an agent runs (the `sequence` script of its `s1` mind, in `minds.byAgent` of the run configuration), the actions
// that can be added, whether each step can run from the state the steps before it leave (the same rule the start check and the command buttons use), and the arguments checked in
// words. Pure: the panel only draws it.

export type MissionStep = SequenceStep;
type Kind = "uav" | "ugv";
const caps = toolsSchemaCapabilities;
const kindWords = (k: string) => (k === "ugv" ? "ground vehicle" : "UAV");

/** The mission of the agent with this key, or none. */
export function missionOf(doc: RunConfigDocument, key: string): MissionStep[] {
  return [...(doc.minds?.byAgent?.[key]?.s1.script.params.steps ?? [])].map((s) => ({ action: s.action, ...(s.args === undefined ? {} : { args: s.args }) }));
}

/** The run configuration with this agent's mission set; an empty list removes the entry (no mission), and an empty `minds` section is dropped. */
export function withMission(doc: RunConfigDocument, key: string, steps: readonly MissionStep[]): RunConfigDocument {
  const byAgent = { ...doc.minds?.byAgent };
  if (steps.length === 0) delete byAgent[key];
  else byAgent[key] = { s1: { script: { name: "sequence", params: { steps: steps.map((s) => ({ action: s.action, ...(s.args === undefined ? {} : { args: s.args as Record<string, unknown> }) })) } } } };
  const { minds: _old, ...rest } = doc;
  const minds = { ...doc.minds, ...(Object.keys(byAgent).length > 0 ? { byAgent } : {}) };
  if (Object.keys(byAgent).length === 0) delete (minds as { byAgent?: unknown }).byAgent;
  return Object.keys(minds).length === 0 ? (rest as RunConfigDocument) : ({ ...rest, minds } as RunConfigDocument);
}

export const insertStep = (steps: readonly MissionStep[], at: number, step: MissionStep): MissionStep[] => [...steps.slice(0, at), step, ...steps.slice(at)];
export const removeStep = (steps: readonly MissionStep[], at: number): MissionStep[] => steps.filter((_, i) => i !== at);
/** Moves the step at `at` up (-1) or down (1); at an end of the list nothing moves. */
export function moveStep(steps: readonly MissionStep[], at: number, delta: -1 | 1): MissionStep[] {
  const to = at + delta;
  if (to < 0 || to >= steps.length) return [...steps];
  const out = [...steps];
  const [s] = out.splice(at, 1);
  out.splice(to, 0, s as MissionStep);
  return out;
}

export interface MenuAction {
  readonly name: string;
  readonly supported: boolean;
  /** Why it is not offered for this vehicle. */
  readonly why?: string;
  /** What it needs, in words (`airborne`, `on the ground`, `a base`), from the capability's preconditions for this vehicle; empty when it needs nothing. */
  readonly needs: string;
}

const NEEDS: Readonly<Record<string, string>> = { airborne: "airborne", grounded: "on the ground", hasBase: "a base", hasRangeSensor: "a range sensor" };

/** The actions an agent of this kind can be given as steps: every action of the manifest, the ones the vehicle does not support greyed with the reason. */
export function actionMenu(kind: Kind): MenuAction[] {
  return caps
    .list()
    .filter((c) => c.kind === "action")
    .map((c) => {
      const supported = caps.vehicles(c.name).includes(kind);
      const needs = caps
        .preconditions(c.name)
        .filter((p) => p.vehicles === undefined || p.vehicles.includes(kind))
        .map((p) => NEEDS[p.name] ?? p.name)
        .join(" · ");
      return supported ? { name: c.name, supported, needs } : { name: c.name, supported, needs, why: `not offered for a ${kindWords(kind)}` };
    });
}

/** The arguments a step added with one click starts with: the manifest accepts them (a take off at the body's cruise altitude, a go to at a point, a hold of five seconds). */
export function defaultArgs(action: string, ctx: { cruiseAltitudeM?: number; x?: number; y?: number } = {}): Record<string, unknown> {
  switch (action) {
    case "takeoff":
      return { altitudeM: ctx.cruiseAltitudeM ?? 20 };
    case "goTo":
      return { xM: ctx.x ?? 0, yM: ctx.y ?? 0 };
    case "hold":
      return { durationS: 5 };
    default:
      return {};
  }
}

interface PropertySchema {
  readonly type?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
}

/** What is wrong with a step's arguments, in words (an empty list when they are valid): a missing field, an unknown one, a number outside its bounds, or the schema's own message. */
export function fieldIssues(step: MissionStep): string[] {
  const def = caps.list().find((c) => c.name === step.action);
  if (!def) return [`${step.action} is not an action of the manifest`];
  const schema = def.paramsSchema as { properties?: Record<string, PropertySchema>; required?: readonly string[] };
  const props = schema.properties ?? {};
  const args = (step.args ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of schema.required ?? []) if (args[k] === undefined) out.push(`${k} is required`);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (p === undefined) {
      out.push(`${k} is not an argument of ${step.action}`);
      continue;
    }
    if (p.type === "number" || p.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${k} must be a number`);
      else if (p.minimum !== undefined && v < p.minimum) out.push(`${k} ${v} is below the minimum ${p.minimum}`);
      else if (p.exclusiveMinimum !== undefined && v <= p.exclusiveMinimum) out.push(`${k} ${v} must be above ${p.exclusiveMinimum}`);
      else if (p.maximum !== undefined && v > p.maximum) out.push(`${k} ${v} is above the maximum ${p.maximum}`);
    }
  }
  if (out.length > 0) return out;
  const v = caps.validate(step.action, step.args ?? {});
  return v.ok ? [] : [v.error.message];
}

export interface Fix {
  /** The step to insert, before the one at `at`. */
  readonly insert: MissionStep;
  readonly at: number;
}

export interface StepRow {
  readonly ok: boolean;
  /** `goTo needs airborne · take off first` when the step cannot run from here. */
  readonly hint?: string;
  /** The one-click fix: a step to insert before this one. */
  readonly fix?: Fix | undefined;
  /** What an earlier step did that makes this one impossible (`returnToBase landed the UAV at step 4`). */
  readonly because?: string;
  /** The state a UAV is in after this step (undefined for a ground vehicle, which has none). */
  readonly after?: "airborne" | "grounded";
  /** What the researcher should know of this step: a hold without a duration never ends. */
  readonly note?: string;
  /** The step is behind one that never ends, so it does not run. */
  readonly blocked?: boolean;
  /** The rule of the step's action after a preemption (the core's). */
  readonly resume: string;
}

/**
 * Whether each step can run, along the list, from the state the steps before it leave: the start check's own rule (`commandAvailability`) evaluated on facts that the steps update
 * (take off makes a UAV airborne, land and return home leave it on the ground). A step that cannot run is still taken to have run, so the rows after it say what they would need.
 */
export function alongList(steps: readonly MissionStep[], start: AgentFacts): StepRow[] {
  let airborne = start.airborne;
  let leftOnGround: { action: string; step: number } | undefined;
  let endless: { step: number } | undefined;
  return steps.map((s, i): StepRow => {
    const kind = start.kind as Kind;
    const resume = resumesAfterPreemption(s.action) ? "resumes after a preemption" : "does not resume after a preemption";
    const facts: AgentFacts = { ...start, airborne };
    let row: Omit<StepRow, "after" | "note" | "blocked" | "resume">;
    if (!caps.vehicles(s.action).includes(kind)) {
      row = { ok: false, hint: `${s.action} is not for a ${kindWords(kind)}`, fix: undefined };
    } else {
      const u = commandAvailability(caps, s.action, facts);
      if (!u) row = { ok: true };
      else {
        const hint = `${s.action} ${describeUnavailable(u, kind)}`;
        const fix: Fix | undefined = u.requires === "airborne" && kind === "uav" ? { insert: { action: "takeoff", args: defaultArgs("takeoff") }, at: i } : u.requires === "grounded" && kind === "uav" ? { insert: { action: "land" }, at: i } : undefined;
        const because = u.requires === "airborne" && leftOnGround ? `${leftOnGround.action} left the UAV on the ground at step ${leftOnGround.step}` : undefined;
        row = { ok: false, hint, fix, ...(because === undefined ? {} : { because }) };
      }
    }
    // What the step leaves behind, for the rows after it (a UAV only).
    if (kind === "uav") {
      if (s.action === "takeoff") {
        airborne = true;
        leftOnGround = undefined;
      } else if (s.action === "land" || s.action === "returnToBase") {
        airborne = false;
        leftOnGround = { action: s.action === "land" ? "land" : "returnToBase", step: i + 1 };
      }
    }
    const holdNoEnd = s.action === "hold" && (s.args as { durationS?: unknown } | undefined)?.durationS === undefined;
    const blocked = endless !== undefined;
    const note = blocked ? `does not run: step ${endless?.step} (hold) never ends` : holdNoEnd ? "never ends: the steps after it do not run" : undefined;
    if (holdNoEnd && endless === undefined) endless = { step: i + 1 };
    return { ...row, ...(kind === "uav" ? { after: airborne ? ("airborne" as const) : ("grounded" as const) } : {}), ...(note === undefined ? {} : { note }), ...(blocked ? { blocked } : {}), resume };
  });
}

export interface MissionStatus {
  readonly steps: number;
  /** Steps with arguments the schema refuses. */
  readonly errors: number;
  /** Steps that cannot run from where the list puts them, or that sit behind a step that never ends. */
  readonly warnings: number;
  /** Nothing to fix: the list can be run. */
  readonly valid: boolean;
}

/** The state of a mission as the section's header and the jump row say it: valid with its number of steps, or how many steps are wrong or cannot run. */
export function missionStatus(steps: readonly MissionStep[], start: AgentFacts): MissionStatus {
  const rows = alongList(steps, start);
  const errors = steps.filter((s) => fieldIssues(s).length > 0).length;
  const warnings = rows.filter((r) => !r.ok || r.blocked === true).length;
  return { steps: steps.length, errors, warnings, valid: errors === 0 && warnings === 0 };
}
