import type { TraceRecord } from "@agentsim/trace";

/**
 * Attention: how a stuck, failed or troubled agent stands out (ADR-0042, UI-SPEC §4 "Attention", `docs/ui/review/attention.md`). Every agent has at most one
 * level, the highest of its active conditions: alarm ✕ (it failed and will not recover by itself, or it is boxed in or out of battery) or warning ▲ (something
 * went wrong and the agent or a reflex is handling it). It is derived from the run's records, so it reads the same live and in replay at a moment, and it is
 * UI-only: never traced, never in a hash, never sent to a mind. What is deferred (F10): acknowledge states, keys, edge indicators, Inspector banners.
 */

export type AttentionLevel = "alarm" | "warning";

export interface Condition {
  /** Stable key of the kind of condition (`failed:collision`, `reflex:obstacle_ahead`, `battery:critical`…). */
  readonly key: string;
  readonly level: AttentionLevel;
  /** `✕` or `▲`. */
  readonly glyph: "✕" | "▲";
  /** The short label with the real code (`collision`, `plan budget`, `boxed in`, `obstacle`, `battery 14 %`). */
  readonly label: string;
  /** The failure, rejection or reflex code the label comes from. */
  readonly code: string;
  readonly sinceS: number;
  /** Where a collision happened (the pin on the map). */
  readonly at?: { readonly xM: number; readonly yM: number };
}

export interface AgentAttention {
  readonly level: AttentionLevel | undefined;
  /** Active conditions, the worst first (alarms before warnings, then the newest). */
  readonly conditions: readonly Condition[];
}

/** The clear rules and thresholds: UI settings, not run configuration (attention.md §4). */
export interface AttentionParams {
  /** A new action that runs this long without failing clears a failure. */
  readonly runClearS: number;
  /** A reflex clears when no new one has fired for this long. */
  readonly reflexClearS: number;
  /** A recovery clears this long after its last record (or when the action ends). */
  readonly recoveryClearS: number;
  /** No movement beyond the footprint for this long while an action runs is "stuck". */
  readonly stuckS: number;
}

export const DEFAULT_ATTENTION: AttentionParams = { runClearS: 2, reflexClearS: 5, recoveryClearS: 5, stuckS: 30 };

/** What the Scene and the Explorer say of a failure code, short (the tooltip and the Inspector have the full message). */
const FAILURE_LABEL: Readonly<Record<string, string>> = {
  collision: "collision",
  unreachable: "unreachable",
  planning_budget: "plan budget",
  no_map_data: "no map",
  geofence: "geofence",
  landing_blocked: "landing",
  kinematically_infeasible: "infeasible",
  battery_depleted: "battery 0",
};

const REFLEX_LABEL: Readonly<Record<string, string>> = { obstacle_ahead: "obstacle", geofence: "geofence" };

/** Battery levels of an agent (state of charge 0..1) with its configured thresholds, for the conditions that come from the status block. */
export interface BatteryFact {
  readonly soc: number;
  readonly lowSoc?: number | undefined;
  readonly criticalSoc?: number | undefined;
}

interface Payload {
  readonly op?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly actionId?: unknown;
  readonly failure?: { readonly code?: unknown } | undefined;
  readonly reflex?: unknown;
  readonly code?: unknown;
  readonly kind?: unknown;
  readonly ok?: unknown;
  readonly xM?: unknown;
  readonly yM?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

interface Track {
  /** The last action failure and when its action ended. */
  failed?: { code: string; label: string; atS: number; boxed: boolean; at?: { xM: number; yM: number } } | undefined;
  /** The start of the action after it (a failure clears when that one has run `runClearS` without failing). */
  startedAfterFailureS?: number | undefined;
  /** The action running now, if any, and when it started. */
  running?: { id: string; startS: number; name: string } | undefined;
  rejected?: { code: string; atS: number } | undefined;
  recovery?: { atS: number } | undefined;
  reflex: Map<string, { atS: number; label: string }>;
  /** `returnToBase` or `land` that ended succeeded after a critical-battery reflex. */
  batteryCriticalAtS?: number | undefined;
  batteryHandledAtS?: number | undefined;
  /** Failed escape recoveries by time: an escape and a back-off that both found nothing are "boxed in". */
  failedEscapeAtS?: number | undefined;
  failedBackoffAtS?: number | undefined;
  collisionAt?: { xM: number; yM: number; atS: number } | undefined;
}

/**
 * The attention of every agent at `atS`, from the run's records in order (records after `atS` are not looked at, so a replay at a cursor and the live run at
 * that moment agree) and the batteries' status. Pure.
 */
export function attention(records: readonly TraceRecord[], atS: number, battery: ReadonlyMap<string, BatteryFact> = new Map(), params: AttentionParams = DEFAULT_ATTENTION): Map<string, AgentAttention> {
  const tracks = new Map<string, Track>();
  const get = (id: string): Track => {
    let t = tracks.get(id);
    if (!t) tracks.set(id, (t = { reflex: new Map() }));
    return t;
  };
  for (const r of records) {
    if (r.agentId === undefined || r.simTime > atS + 1e-9) continue;
    const p = (r.payload ?? {}) as Payload;
    const t = get(r.agentId);
    if (r.kind === "action") {
      if (p.op === "start") {
        t.running = { id: str(p.actionId) ?? "", startS: r.simTime, name: str(p.name) ?? "" };
        if (t.failed) t.startedAfterFailureS = r.simTime;
        if (t.rejected) t.rejected = undefined; // the next accepted start clears a rejection
      } else if (p.op === "end") {
        const status = str(p.status);
        if (status === "failed") {
          const code = str(p.failure?.code) ?? "failed";
          const near2 = (x: number | undefined) => x !== undefined && Math.abs(x - r.simTime) < 0.25;
          const boxed = code === "kinematically_infeasible" && near2(t.failedEscapeAtS) && near2(t.failedBackoffAtS);
          const near = t.collisionAt !== undefined && r.simTime - t.collisionAt.atS < 1 ? { xM: t.collisionAt.xM, yM: t.collisionAt.yM } : undefined;
          t.failed = { code, label: boxed ? "boxed in" : (FAILURE_LABEL[code] ?? code), atS: r.simTime, boxed, ...(code === "collision" && near ? { at: near } : {}) };
          t.startedAfterFailureS = undefined;
        } else if (status === "succeeded" && (t.running?.name === "returnToBase" || t.running?.name === "land") && t.batteryCriticalAtS !== undefined) t.batteryHandledAtS = r.simTime;
        if (t.running?.id === str(p.actionId) || t.running === undefined) t.running = undefined;
        t.recovery = undefined;
      } else if (p.op === "rejected") {
        t.rejected = { code: str(p.failure?.code) ?? "rejected", atS: r.simTime };
      } else if (p.op === "recovery") {
        if (p.ok === false) {
          if (str(p.kind) === "escape") t.failedEscapeAtS = r.simTime;
          else if (str(p.kind) === "back-off") t.failedBackoffAtS = r.simTime;
        } else t.recovery = { atS: r.simTime };
      }
    } else if (r.kind === "reflex") {
      const code = str(p.code) ?? "";
      if (code === "battery_critical") t.batteryCriticalAtS = r.simTime;
      else if (REFLEX_LABEL[code]) t.reflex.set(code, { atS: r.simTime, label: REFLEX_LABEL[code] as string });
    } else if (r.kind === "event" && p.op === "collision") {
      const x = num(p.xM);
      const y = num(p.yM);
      if (x !== undefined && y !== undefined) t.collisionAt = { xM: x, yM: y, atS: r.simTime };
    }
  }

  const out = new Map<string, AgentAttention>();
  const ids = new Set<string>([...tracks.keys(), ...battery.keys()]);
  for (const id of ids) {
    const t: Track = tracks.get(id) ?? { reflex: new Map() };
    const list: Condition[] = [];
    const f = t.failed;
    if (f) {
      const cleared = f.code !== "battery_depleted" && t.startedAfterFailureS !== undefined && t.running !== undefined && t.running.startS === t.startedAfterFailureS && atS - t.startedAfterFailureS >= params.runClearS;
      if (!cleared) list.push({ key: `failed:${f.boxed ? "boxed" : f.code}`, level: "alarm", glyph: "✕", label: f.label, code: f.code, sinceS: f.atS, ...(f.at ? { at: f.at } : {}) });
    }
    const b = battery.get(id);
    if (b && b.soc <= 0 && !(f?.code === "battery_depleted")) list.push({ key: "battery:0", level: "alarm", glyph: "✕", label: "battery 0", code: "battery_depleted", sinceS: atS });
    if (t.rejected) list.push({ key: `rejected:${t.rejected.code}`, level: "warning", glyph: "▲", label: `rejected · ${t.rejected.code}`, code: t.rejected.code, sinceS: t.rejected.atS });
    if (t.recovery && t.running && atS - t.recovery.atS < params.recoveryClearS) list.push({ key: "recovery", level: "warning", glyph: "▲", label: "recovering", code: "recovery", sinceS: t.recovery.atS });
    for (const [code, x] of t.reflex) if (atS - x.atS < params.reflexClearS) list.push({ key: `reflex:${code}`, level: "warning", glyph: "▲", label: x.label, code, sinceS: x.atS });
    if (b && b.soc > 0) {
      const critical = b.criticalSoc !== undefined && b.soc <= b.criticalSoc;
      const handled = t.batteryHandledAtS !== undefined;
      if (critical && !handled) list.push({ key: "battery:critical", level: "warning", glyph: "▲", label: `battery ${Math.round(b.soc * 100)} %`, code: "battery_critical", sinceS: t.batteryCriticalAtS ?? atS });
      else if (!critical && b.lowSoc !== undefined && b.soc <= b.lowSoc) list.push({ key: "battery:low", level: "warning", glyph: "▲", label: `battery ${Math.round(b.soc * 100)} %`, code: "battery_low", sinceS: atS });
    }
    list.sort((a, c) => (a.level === c.level ? c.sinceS - a.sinceS : a.level === "alarm" ? -1 : 1));
    out.set(id, { level: list[0]?.level, conditions: list });
  }
  return out;
}

/** A pose sample for the stuck rule: where the agent was and when (sim seconds). */
export interface PoseSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Stuck: while an action runs the agent has moved no more than `radiusM` over the last `params.stuckS` seconds. Needs pose history that spans that long (live: the
 * status polls; replay: what the cursor has passed), so it is a separate rule from the record-derived ones.
 */
export function isStuck(samples: readonly PoseSample[], atS: number, radiusM: number, running: boolean, params: AttentionParams = DEFAULT_ATTENTION): boolean {
  if (!running || samples.length === 0) return false;
  const from = atS - params.stuckS;
  const first = samples[0] as PoseSample;
  if (first.t > from + 1e-9) return false; // not enough history to say
  let ref: PoseSample | undefined;
  for (const s of samples) {
    if (s.t <= atS && s.t >= from) {
      ref ??= s;
      if (Math.hypot(s.x - ref.x, s.y - ref.y) > radiusM) return false;
    }
  }
  return ref !== undefined;
}

/** The stuck condition, to join an agent's conditions. */
export const stuckCondition = (atS: number, params: AttentionParams = DEFAULT_ATTENTION): Condition => ({ key: "stuck", level: "warning", glyph: "▲", label: `stuck ${params.stuckS} s`, code: "stuck", sinceS: atS - params.stuckS });

/** Adds a condition to an agent's attention, keeping the order and the level. */
export function withCondition(a: AgentAttention | undefined, c: Condition): AgentAttention {
  const list = [...(a?.conditions ?? []), c].sort((x, y) => (x.level === y.level ? y.sinceS - x.sinceS : x.level === "alarm" ? -1 : 1));
  return { level: list[0]?.level, conditions: list };
}

/** Counts for the player tile and the Explorer header: agents at each level. */
export function attentionCounts(all: ReadonlyMap<string, AgentAttention>): { readonly alarm: number; readonly warning: number } {
  let alarm = 0;
  let warning = 0;
  for (const a of all.values()) {
    if (a.level === "alarm") alarm++;
    else if (a.level === "warning") warning++;
  }
  return { alarm, warning };
}
