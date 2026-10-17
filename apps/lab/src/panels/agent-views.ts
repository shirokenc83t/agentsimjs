import type { TraceRecord } from "@agentsim/trace";
import type { StateName } from "@agentsim/ui";

/** An agent's current (or last) action, from its `action` trace records. */
export interface ActionView {
  readonly actionId: string;
  readonly name: string;
  readonly status: "running" | "succeeded" | "failed" | "preempted";
  readonly phase: string | undefined;
  readonly failure: string | undefined;
  readonly startedAtS: number;
}

export interface PlanView {
  readonly seq: number;
  readonly algorithm: string;
  readonly status: string;
  readonly expansionsCharged: number;
  readonly completedTick: number;
  readonly waypoints: [number, number][];
  /** Length of the smoothed path (m). */
  readonly lengthM: number;
}

export interface ReflexView {
  readonly reflex: string;
  readonly code: string;
  readonly then: string | undefined;
  readonly atS: number;
}

/** The agent's latest researcher command (an `injected` record): accepted, or refused with its stable code. */
export interface CommandView {
  readonly name: string;
  readonly ok: boolean;
  readonly failure: string | undefined;
  readonly atS: number;
}

export interface AgentViews {
  readonly command: CommandView | undefined;
  readonly action: ActionView | undefined;
  readonly plan: PlanView | undefined;
  readonly reflex: ReflexView | undefined;
}

interface Payload {
  readonly op?: unknown;
  readonly actionId?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly to?: unknown;
  readonly failure?: { readonly code?: unknown } | undefined;
  readonly algorithm?: unknown;
  readonly expansionsCharged?: unknown;
  readonly completedTick?: unknown;
  readonly waypoints?: unknown;
  readonly reflex?: unknown;
  readonly code?: unknown;
  readonly then?: unknown;
  readonly ok?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function pathLength(w: readonly (readonly [number, number])[]): number {
  let l = 0;
  for (let k = 1; k < w.length; k++) l += Math.hypot((w[k]?.[0] ?? 0) - (w[k - 1]?.[0] ?? 0), (w[k]?.[1] ?? 0) - (w[k - 1]?.[1] ?? 0));
  return l;
}

/**
 * Per-agent views for the Explorer and Inspector, derived from the run's trace records in order: the latest
 * action (start, phase changes, end), the latest found plan (`compute`) and the latest reflex. Records are
 * data from the worker; nothing here simulates.
 */
export function agentViews(records: readonly TraceRecord[]): Map<string, AgentViews> {
  const out = new Map<string, { command: CommandView | undefined; action: ActionView | undefined; plan: PlanView | undefined; reflex: ReflexView | undefined }>();
  const get = (id: string) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { command: undefined, action: undefined, plan: undefined, reflex: undefined }));
    return v;
  };
  for (const r of records) {
    if (r.agentId === undefined) continue;
    const p = (r.payload ?? {}) as Payload;
    const v = get(r.agentId);
    if (r.kind === "action") {
      const actionId = str(p.actionId);
      if (p.op === "start" && actionId) {
        v.action = { actionId, name: str(p.name) ?? "?", status: "running", phase: undefined, failure: undefined, startedAtS: r.simTime };
      } else if (p.op === "phase" && v.action && v.action.actionId === actionId) {
        v.action = { ...v.action, phase: str(p.to) };
      } else if (p.op === "end" && v.action && v.action.actionId === actionId) {
        const status = str(p.status);
        if (status === "succeeded" || status === "failed" || status === "preempted") {
          v.action = { ...v.action, status, phase: undefined, failure: str(p.failure?.code) };
        }
      }
    } else if (r.kind === "compute" && p.op === "plan" && p.status === "found" && Array.isArray(p.waypoints)) {
      const waypoints = p.waypoints as [number, number][];
      v.plan = {
        seq: r.seq,
        algorithm: typeof p.algorithm === "string" ? p.algorithm : JSON.stringify(p.algorithm ?? "?"),
        status: "found",
        expansionsCharged: num(p.expansionsCharged),
        completedTick: num(p.completedTick),
        waypoints,
        lengthM: pathLength(waypoints),
      };
    } else if (r.kind === "injected" && p.op === "command") {
      const failure = typeof (p as { failure?: unknown }).failure === "string" ? ((p as { failure?: string }).failure as string) : undefined;
      v.command = { name: str(p.name) ?? "?", ok: p.ok === true, failure, atS: r.simTime };
    } else if (r.kind === "reflex") {
      v.reflex = { reflex: str(p.reflex) ?? "?", code: str(p.code) ?? "?", then: str(p.then), atS: r.simTime };
    }
  }
  return out;
}

/** State glyph of an action status (ADR-0032 §5: always glyph + text). */
export function actionState(a: ActionView | undefined): StateName {
  if (!a) return "idle";
  switch (a.status) {
    case "running":
      return "run";
    case "succeeded":
      return "ok";
    case "failed":
      return "alm";
    case "preempted":
      return "warn";
  }
}

/** One line for an action: `goTo · following`, `goTo · failed · unreachable`, `idle`. */
export function actionLabel(a: ActionView | undefined): string {
  if (!a) return "idle";
  if (a.status === "running") return a.phase ? `${a.name} · ${a.phase}` : a.name;
  return a.failure ? `${a.name} · ${a.status} · ${a.failure}` : `${a.name} · ${a.status}`;
}

/** Waypoints as "(x, y) → (x, y) …" in metres; long paths are cut after the first `max` points. */
export function waypointsText(wp: readonly (readonly [number, number])[], max = 12): string {
  const shown = wp.slice(0, max).map(([x, y]) => `(${x.toFixed(1)}, ${y.toFixed(1)})`).join(" → ");
  return wp.length > max ? `${shown} … +${wp.length - max}` : shown;
}
