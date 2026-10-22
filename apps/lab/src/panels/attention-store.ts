import { STATUS_STRIDE, type SimLoadedMessage } from "@agentsim/core";
import { useCallback } from "react";
import { usePolled } from "../services.tsx";
import type { RunSnapshot, RunSource } from "../sim/run-source.ts";
import { attention, attentionCounts, DEFAULT_ATTENTION, isStuck, stuckCondition, withCondition, type AgentAttention, type BatteryFact, type PoseSample } from "./attention.ts";

/**
 * The attention of every agent now (ADR-0042, UI-SPEC §4), derived from the run's records at the moment the panels show (the sim head live, the cursor in replay),
 * the batteries' status and, for the stuck rule, the poses seen so far. Computed at most once per poll for any number of readers (the Scene, the Explorer, the
 * player) and cached per source. UI-only: nothing here is traced, hashed or sent anywhere.
 */
export interface AttentionView {
  readonly byAgent: ReadonlyMap<string, AgentAttention>;
  readonly counts: { readonly alarm: number; readonly warning: number };
}

const EMPTY: AttentionView = { byAgent: new Map(), counts: { alarm: 0, warning: 0 } };

interface Cache {
  key: string;
  value: AttentionView;
  /** Poses seen per agent, for the stuck rule: kept for the stuck window and a little more. */
  history: Map<string, PoseSample[]>;
  runId: string | undefined;
  lastAtS: number;
}

const caches = new WeakMap<RunSource, Cache>();

interface BodyConfig {
  readonly battery?: { readonly lowSoc?: number; readonly criticalSoc?: number };
  readonly footprintRadiusM?: number;
}

const bodyOf = (run: SimLoadedMessage, id: string): BodyConfig => ((run.agents.find((a) => a.id === id)?.config as { body?: BodyConfig } | undefined)?.body ?? {}) as BodyConfig;

export function attentionNow(source: RunSource, snap: RunSnapshot): AttentionView {
  const run = snap.run;
  if (!run) return EMPTY;
  const records = source.records();
  const atS = snap.simTimeS;
  let c = caches.get(source);
  if (!c) caches.set(source, (c = { key: "", value: EMPTY, history: new Map(), runId: undefined, lastAtS: 0 }));
  // Poses are sampled while time moves forward; a new run, or the cursor going back, starts the history again.
  if (c.runId !== snap.runId || atS < c.lastAtS - 1e-9) c.history = new Map();
  const key = `${snap.runId}|${records.length}|${atS.toFixed(2)}|${snap.agentStatus ? snap.agentStatus[0] : 0}`;
  if (c.key === key) return c.value;
  c.runId = snap.runId;
  c.lastAtS = atS;
  c.key = key;

  const battery = new Map<string, BatteryFact>();
  const st = snap.agentStatus;
  snap.entityIds.forEach((id, i) => {
    const b = bodyOf(run, id).battery;
    const soc = st ? st[i * STATUS_STRIDE] : undefined;
    if (soc !== undefined) battery.set(id, { soc, lowSoc: b?.lowSoc, criticalSoc: b?.criticalSoc });
    const pose = source.pose(i);
    if (pose) {
      const list = c.history.get(id) ?? [];
      const last = list[list.length - 1];
      if (!last || atS > last.t + 1e-9) list.push({ t: atS, x: pose.x, y: pose.y });
      while (list.length > 2 && (list[1] as PoseSample).t < atS - DEFAULT_ATTENTION.stuckS - 5) list.shift();
      c.history.set(id, list);
    }
  });
  const base = attention(records, atS, battery);
  // An action is running when its last record is a start; stuck is only a question then.
  const running = new Set<string>();
  for (const r of records) {
    if (r.kind !== "action" || r.agentId === undefined || r.simTime > atS + 1e-9) continue;
    const op = (r.payload as { op?: unknown } | null)?.op;
    if (op === "start") running.add(r.agentId);
    else if (op === "end") running.delete(r.agentId);
  }
  const out = new Map(base);
  for (const id of snap.entityIds) {
    const r = bodyOf(run, id).footprintRadiusM ?? 0.5;
    if (isStuck(c.history.get(id) ?? [], atS, r, running.has(id))) out.set(id, withCondition(out.get(id), stuckCondition(atS)));
  }
  c.value = { byAgent: out, counts: attentionCounts(out) };
  return c.value;
}

/** The attention of every agent, at the panel poll rate (10 Hz at most). */
export function useAttention(source: RunSource): AttentionView {
  return usePolled(useCallback(() => attentionNow(source, source.snapshot()), [source]), 100);
}
