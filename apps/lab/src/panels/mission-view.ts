import { resumesAfterPreemption } from "@agentsim/core";
import type { TraceRecord } from "@agentsim/trace";
import { reflexWords } from "./agent-views.ts";

// The progress of an agent's mission (F3c M1), derived from the run's trace records alone, nothing simulated: the steps come from the agent's `config` record, the state of each from the
// decision record that began it, the action that decision started and how the action ended; a stop is the decision that carries it. Pure, so the Inspector, Explorer, Scene and the
// player all say the same thing.

export type StepState = "pending" | "running" | "done" | "preempted" | "refused" | "failed" | "skipped";

/** The glyph of a step's state (ADR-0032 §5: a glyph always comes with its text). */
export const STEP_GLYPH: Readonly<Record<StepState, string>> = { done: "✓", running: "▶", pending: "○", preempted: "▲", refused: "✕", failed: "✕", skipped: "–" };

export interface MissionStepView {
  readonly index: number;
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>> | undefined;
  readonly state: StepState;
  /** The phase while running, the stable code of a refusal or failure, the reflex of a preemption. */
  readonly detail: string | undefined;
  readonly startedAtS: number | undefined;
  readonly endedAtS: number | undefined;
  readonly durationS: number | undefined;
  /** The decision record that began the step: what a click on the step selects. */
  readonly decisionId: string | undefined;
  readonly decisionSeq: number | undefined;
}

export interface MissionStopView {
  /** 1-based. */
  readonly step: number;
  readonly action: string;
  readonly status: "refused" | "failed" | "preempted";
  readonly code: string;
  readonly line: string;
}

export interface MissionView {
  readonly steps: readonly MissionStepView[];
  readonly of: number;
  /** 1-based number of the step running, or the last one begun; 0 before the first. */
  readonly current: number;
  readonly status: "ready" | "running" | "done" | "stopped";
  readonly stop: MissionStopView | undefined;
}

interface Payload {
  readonly op?: unknown;
  readonly actionId?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly to?: unknown;
  readonly failure?: unknown;
  readonly step?: unknown;
  readonly done?: unknown;
  readonly stop?: { readonly status?: unknown; readonly action?: unknown; readonly code?: unknown };
  readonly mind?: { readonly s1?: { readonly script?: { readonly params?: { readonly steps?: unknown } } } };
  readonly reflex?: unknown;
  readonly code?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const failureCode = (f: unknown): string | undefined => (typeof f === "string" ? f : str((f as { code?: unknown } | undefined)?.code));
const time = (s: number) => `${s.toFixed(1)} s`;

interface Mutable {
  state: StepState;
  detail: string | undefined;
  startedAtS: number | undefined;
  endedAtS: number | undefined;
  decisionId: string | undefined;
  decisionSeq: number | undefined;
}

/** The mission of one agent from the run's records, or undefined when its configuration has none. */
export function missionViewOf(records: readonly TraceRecord[], agentId: string): MissionView | undefined {
  let defs: readonly { action: string; args?: Record<string, unknown> }[] | undefined;
  for (const r of records) {
    if (r.agentId !== agentId || r.kind !== "lifecycle") continue;
    const p = (r.payload ?? {}) as Payload;
    if (p.op !== "config") continue;
    const steps = p.mind?.s1?.script?.params?.steps;
    if (Array.isArray(steps)) defs = steps as typeof defs;
  }
  if (defs === undefined || defs.length === 0) return undefined;
  const of = defs.length;
  const rows: Mutable[] = defs.map(() => ({ state: "pending", detail: undefined, startedAtS: undefined, endedAtS: undefined, decisionId: undefined, decisionSeq: undefined }));
  const byDecision = new Map<string, number>();
  const byAction = new Map<string, number>();
  let current = 0;
  let status: MissionView["status"] = "ready";
  let stop: { step: number; status: "refused" | "failed" | "preempted"; action: string; code: string } | undefined;
  let lastReflex: { code: string; atS: number } | undefined;
  for (const r of records) {
    if (r.agentId !== agentId) continue;
    const p = (r.payload ?? {}) as Payload;
    if (r.kind === "thought" && p.op === "decision" && typeof p.step === "number") {
      const i = p.step - 1;
      const row = rows[i];
      if (row === undefined) continue;
      if (p.stop !== undefined) {
        const s = str(p.stop.status);
        if (s === "refused" || s === "failed" || s === "preempted") {
          stop = { step: p.step, status: s, action: str(p.stop.action) ?? "?", code: str(p.stop.code) ?? "?" };
          status = "stopped";
          if (row.state === "running" || row.state === "pending") row.state = s;
        }
      } else if (p.done === true) {
        row.state = "done";
        status = "done";
      } else {
        row.decisionId = r.id;
        row.decisionSeq = r.seq;
        row.state = "running";
        byDecision.set(r.id, i);
        current = p.step;
        status = "running";
      }
    } else if (r.kind === "action") {
      const cause = (r.causeIds ?? []).map((c) => byDecision.get(c)).find((c) => c !== undefined);
      const actionId = str(p.actionId);
      if (p.op === "start" && actionId !== undefined && cause !== undefined) {
        byAction.set(actionId, cause);
        const row = rows[cause] as Mutable;
        row.startedAtS = r.simTime;
      } else if (p.op === "rejected" && cause !== undefined) {
        const row = rows[cause] as Mutable;
        row.state = "refused";
        row.detail = failureCode(p.failure);
      } else if (p.op === "phase" && actionId !== undefined) {
        const i = byAction.get(actionId);
        const row = i === undefined ? undefined : rows[i];
        if (row !== undefined && row.state === "running") row.detail = str(p.to);
      } else if (p.op === "end" && actionId !== undefined) {
        const i = byAction.get(actionId);
        const row = i === undefined ? undefined : rows[i];
        if (row === undefined) continue;
        row.endedAtS = r.simTime;
        const s = str(p.status);
        if (s === "succeeded") {
          row.state = "done";
          row.detail = undefined;
        } else if (s === "failed") {
          row.state = "failed";
          row.detail = failureCode(p.failure);
        } else if (s === "preempted") {
          row.state = "preempted";
          row.detail = lastReflex !== undefined && lastReflex.atS >= (row.startedAtS ?? 0) ? reflexWords(lastReflex.code) : undefined;
        }
      }
    } else if (r.kind === "reflex") {
      lastReflex = { code: str(p.code) ?? "?", atS: r.simTime };
    }
  }
  if (stop !== undefined) for (let i = stop.step; i < of; i++) (rows[i] as Mutable).state = "skipped";
  const steps = rows.map((row, i): MissionStepView => {
    const d = defs?.[i] as { action: string; args?: Record<string, unknown> };
    const durationS = row.startedAtS !== undefined && row.endedAtS !== undefined ? row.endedAtS - row.startedAtS : undefined;
    return { index: i, action: d.action, args: d.args, ...row, durationS };
  });
  let stopView: MissionStopView | undefined;
  if (stop !== undefined) {
    const row = steps[stop.step - 1] as MissionStepView;
    const not = stop.step < of ? ` · step${stop.step + 1 === of ? "" : "s"} ${stop.step + 1}${stop.step + 1 === of ? "" : `–${of}`} not run` : "";
    const head = `Mission stopped at step ${stop.step} of ${of} · ${stop.action}`;
    let body: string;
    if (stop.status === "refused") body = ` refused: ${stop.code}`;
    else if (stop.status === "failed") body = ` failed${row.endedAtS === undefined ? "" : ` at ${time(row.endedAtS)}`}: ${stop.code}`;
    else body = ` preempted${row.endedAtS === undefined ? "" : ` at ${time(row.endedAtS)}`}${row.detail === undefined ? "" : ` by ${row.detail}`}${resumesAfterPreemption(stop.action) ? "" : ` · ${stop.action} does not resume after a preemption`}`;
    stopView = { step: stop.step, action: stop.action, status: stop.status, code: stop.code, line: `${head}${body}${not}` };
  }
  return { steps, of, current, status, stop: stopView };
}

/** The Scene badge and the Explorer cell: `▶ 3/5`, `✓ 5/5`, `■ 3/5`; empty before the mission has begun. */
export function missionBadge(v: MissionView | undefined): string {
  if (v === undefined) return "";
  const n = `${v.current}/${v.of}`;
  return v.status === "done" ? `✓ ${n}` : v.status === "stopped" ? `■ ${n}` : v.status === "running" ? `▶ ${n}` : `○ 0/${v.of}`;
}

/** The player's words: `uav-001 mission 3 / 5 · explore`, `… · done`, `… · stopped`. */
export function missionLine(v: MissionView | undefined, agentId: string): string {
  if (v === undefined) return "";
  const step = v.steps[Math.max(0, v.current - 1)];
  const tail = v.status === "done" ? "done" : v.status === "stopped" ? `${step?.action ?? ""} ${step?.state ?? ""}`.trim() : (step?.action ?? "not started");
  return `${agentId} mission ${v.current} / ${v.of} · ${tail}`;
}

/** The mission of every agent that has one: one pass over the records finds who has a mission, and only those are followed. */
export function missionViews(records: readonly TraceRecord[]): Map<string, MissionView> {
  const out = new Map<string, MissionView>();
  const ids = new Set<string>();
  for (const r of records) if (r.agentId !== undefined && r.kind === "lifecycle" && (r.payload as Payload | undefined)?.op === "config" && (r.payload as Payload).mind !== undefined) ids.add(r.agentId);
  for (const id of ids) {
    const v = missionViewOf(records, id);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

/** The rest of a mission on the map: from where the agent is, through the points (`goTo`) of the steps not yet done, in metres as x, y pairs; undefined when no point is left to go to. */
export function missionPoints(v: MissionView | undefined, from: { readonly x: number; readonly y: number } | undefined): Float32Array | undefined {
  if (v === undefined || from === undefined || v.status === "done" || v.status === "stopped") return undefined;
  const to = v.steps.filter((s) => (s.state === "running" || s.state === "pending") && s.action === "goTo").flatMap((s) => (typeof s.args?.["xM"] === "number" && typeof s.args["yM"] === "number" ? [[s.args["xM"], s.args["yM"]] as const] : []));
  if (to.length === 0) return undefined;
  return Float32Array.from([from.x, from.y, ...to.flat()]);
}
