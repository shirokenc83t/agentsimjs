import type { StateHasher } from "../numerics/state-hash.ts";

/**
 * Events delivered to minds (ADR-0005 addition of 2026-10-09, F2 M2d). Every field is something the agent itself
 * knows or perceived; nothing here is ground truth. Key order is fixed (a request is serialized byte for byte
 * the same for every mind).
 */
export type DecisionEvent =
  | { readonly kind: "start" }
  | { readonly kind: "actionCompleted"; readonly actionId: string; readonly name: string; readonly result: unknown }
  | {
      /** The action failed, or a reflex or a world command preempted it (`code` is the failure or preemption code). */
      readonly kind: "actionFailed";
      readonly actionId: string;
      readonly name: string;
      readonly status: "failed" | "preempted";
      readonly code: string;
    }
  | { readonly kind: "actionRejected"; readonly name: string; readonly code: string }
  | { readonly kind: "batteryLow"; readonly soc: number; readonly level: number }
  | { readonly kind: "timer"; readonly tag: string }
  | { readonly kind: "frontierExhausted" }
  | {
      readonly kind: "lost";
      readonly entityId: string;
      readonly entityKind: string;
      readonly lastSeenS: number;
      /** Detected/lost transitions of this entity since the last request. */
      readonly transitions: number;
    }
  | {
      readonly kind: "detected";
      readonly entityId: string;
      /** F2 idealization (ADR-0005 addition of 2026-10-11): cameras classify perfectly, so the kind is given. */
      readonly entityKind: string;
      readonly xM: number;
      readonly yM: number;
      readonly zM: number;
      readonly observedAtS: number;
      readonly transitions: number;
    };

export type DecisionEventKind = DecisionEvent["kind"];

/** An event produced outside the world loop (perception, discovery): for which agent, and what. */
export interface AgentEvent {
  readonly agentId: string;
  readonly event: DecisionEvent;
}

/** Fixed order of kinds within a tick (ADR-0005 addition): rejected, failed, completed, battery, timer, frontier, lost, detected, start. */
const RANK: Readonly<Record<DecisionEventKind, number>> = {
  actionRejected: 0,
  actionFailed: 1,
  actionCompleted: 2,
  batteryLow: 3,
  timer: 4,
  frontierExhausted: 5,
  lost: 6,
  detected: 7,
  start: 8,
};

/** Control events are never dropped and always request a decision; the others are perception events. */
export function isControl(kind: DecisionEventKind): boolean {
  return kind !== "detected" && kind !== "lost" && kind !== "frontierExhausted";
}

/** Entries an inbox hands to a request at most; only perception entries are dropped over it. */
export const INBOX_CAP = 32;

function subjectOf(e: DecisionEvent): string {
  switch (e.kind) {
    case "actionCompleted":
    case "actionFailed":
      return e.actionId;
    case "actionRejected":
      return e.name;
    case "timer":
      return e.tag;
    case "lost":
    case "detected":
      return e.entityId;
    default:
      return "";
  }
}

interface Entry {
  readonly tick: number;
  readonly seq: number;
  readonly event: DecisionEvent;
}

/**
 * One agent's inbox (ADR-0005 addition): undelivered events, in the state hash only when not empty. Perception
 * events are coalesced per subject (one entry per entity with its latest state and the number of transitions; the
 * frontier event at most once); control events are kept as they are. `take` orders them (tick, kind, subject,
 * emission order) and, only if still over the cap, drops the oldest perception entries and counts them.
 */
export class Inbox {
  private entries: Entry[] = [];
  private seq = 0;

  get size(): number {
    return this.entries.length;
  }

  hasControl(): boolean {
    return this.entries.some((e) => isControl(e.event.kind));
  }

  add(event: DecisionEvent, tick: number): void {
    if (event.kind === "detected" || event.kind === "lost") {
      const at = this.entries.findIndex((e) => (e.event.kind === "detected" || e.event.kind === "lost") && e.event.entityId === event.entityId);
      const prev = at >= 0 ? (this.entries[at] as Entry).event : undefined;
      if (at >= 0 && prev && (prev.kind === "detected" || prev.kind === "lost")) {
        this.entries[at] = { tick, seq: this.seq++, event: { ...event, transitions: prev.transitions + event.transitions } };
        return;
      }
    } else if (event.kind === "frontierExhausted" && this.entries.some((e) => e.event.kind === "frontierExhausted")) return;
    this.entries.push({ tick, seq: this.seq++, event });
  }

  /** Every undelivered event, in delivery order, and how many perception entries the cap dropped. Empties the inbox. */
  take(): { readonly events: DecisionEvent[]; readonly dropped: number } {
    const r = this.preview();
    this.entries = [];
    return r;
  }

  /** What `take()` would deliver now, leaving the inbox as it is (pure: for the researcher's view of a request). */
  preview(): { readonly events: DecisionEvent[]; readonly dropped: number } {
    const sorted = [...this.entries].sort(
      (a, b) =>
        a.tick - b.tick ||
        RANK[a.event.kind] - RANK[b.event.kind] ||
        (subjectOf(a.event) < subjectOf(b.event) ? -1 : subjectOf(a.event) > subjectOf(b.event) ? 1 : 0) ||
        a.seq - b.seq,
    );
    let dropped = 0;
    // Oldest first in `sorted` by tick, then rank: drop perception entries from the front until under the cap.
    for (let k = 0; sorted.length - dropped > INBOX_CAP && k < sorted.length; k++) {
      const e = sorted[k] as Entry;
      if (isControl(e.event.kind)) continue;
      sorted[k] = { ...e, tick: -1 }; // mark
      dropped++;
    }
    const events = sorted.filter((e) => e.tick !== -1).map((e) => e.event);
    return { events, dropped };
  }

  /** In the state hash only when not empty (runs with nothing pending keep their hash). */
  hashInto(h: StateHasher, agentId: string): void {
    if (this.entries.length === 0) return;
    h.str(agentId).u32(this.entries.length);
    for (const e of this.entries) h.u32(e.tick).str(JSON.stringify(e.event));
  }
}
