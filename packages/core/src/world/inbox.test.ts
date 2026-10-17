import { describe, expect, it } from "vitest";
import { StateHasher } from "../numerics/state-hash.ts";
import { Inbox, INBOX_CAP, type DecisionEvent } from "./events.ts";

const detected = (id: string, transitions = 1): DecisionEvent => ({ kind: "detected", entityId: id, entityKind: "target", xM: 1, yM: 2, zM: 0, observedAtS: 1, transitions });
const lost = (id: string): DecisionEvent => ({ kind: "lost", entityId: id, entityKind: "target", lastSeenS: 1, transitions: 1 });
const failed = (id: string): DecisionEvent => ({ kind: "actionFailed", actionId: id, name: "goTo", status: "failed", code: "unreachable" });
const kinds = (es: readonly DecisionEvent[]) => es.map((e) => e.kind);

describe("inbox (ADR-0005 addition of 2026-10-09)", () => {
  it("orders one tick by kind, then subject, then emission order; earlier ticks come first", () => {
    const b = new Inbox();
    b.add(detected("o-2"), 5);
    b.add({ kind: "start" }, 5);
    b.add(lost("o-1"), 5);
    b.add(failed("act-2"), 5);
    b.add({ kind: "timer", tag: "t" }, 5);
    b.add({ kind: "actionRejected", name: "x", code: "c" }, 5);
    b.add({ kind: "batteryLow", soc: 0.3, level: 0.3 }, 5);
    b.add({ kind: "actionCompleted", actionId: "act-1", name: "hold", result: {} }, 5);
    b.add({ kind: "frontierExhausted" }, 5);
    b.add(detected("o-0"), 4); // an earlier tick keeps its place
    expect(kinds(b.take().events)).toEqual(["detected", "actionRejected", "actionFailed", "actionCompleted", "batteryLow", "timer", "frontierExhausted", "lost", "detected", "start"]);
  });

  it("is deterministic whatever the emission order of several detections in one tick", () => {
    const ids = ["o-3", "o-1", "o-5", "o-2", "o-4"];
    const run = (order: string[]) => {
      const b = new Inbox();
      for (const id of order) b.add(detected(id), 7);
      return b.take().events.map((e) => (e as { entityId: string }).entityId);
    };
    expect(run(ids)).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5"]);
    expect(run([...ids].reverse())).toEqual(run(ids));
  });

  it("coalesces perception per entity (latest state, transition count) and the frontier event at most once", () => {
    const b = new Inbox();
    b.add(detected("o-1"), 1);
    b.add(lost("o-1"), 3);
    b.add(detected("o-1"), 5);
    b.add({ kind: "frontierExhausted" }, 5);
    b.add({ kind: "frontierExhausted" }, 6);
    const { events } = b.take();
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.kind === "detected")).toMatchObject({ entityId: "o-1", transitions: 3 });
    expect(b.size).toBe(0);
  });

  it("a burst of 500 detections never loses a control event: perception is coalesced, then the oldest dropped and counted", () => {
    const b = new Inbox();
    b.add(failed("act-1"), 1);
    for (let k = 0; k < 500; k++) b.add(detected(`o-${String(k % 100).padStart(3, "0")}`), 2 + (k % 7)); // 100 entities, repeated
    b.add({ kind: "timer", tag: "t" }, 9);
    const { events, dropped } = b.take();
    expect(events).toHaveLength(INBOX_CAP);
    expect(dropped).toBe(100 + 2 - INBOX_CAP);
    expect(events.some((e) => e.kind === "actionFailed")).toBe(true);
    expect(events.some((e) => e.kind === "timer")).toBe(true);
    // 100 entities × 5 repeats: each surviving entry carries its transitions.
    expect(events.filter((e) => e.kind === "detected").every((e) => (e as { transitions: number }).transitions === 5)).toBe(true);
  });

  it("control events alone may exceed the cap: none is ever dropped", () => {
    const b = new Inbox();
    for (let k = 0; k < 40; k++) b.add(failed(`act-${String(k).padStart(3, "0")}`), 1);
    const { events, dropped } = b.take();
    expect([events.length, dropped]).toEqual([40, 0]);
  });

  it("is in the state hash only when it holds something", () => {
    const hash = (b: Inbox) => {
      const h = new StateHasher();
      h.u32(1);
      b.hashInto(h, "ugv-001");
      return h.hex();
    };
    const empty = new Inbox();
    const base = hash(empty);
    const b = new Inbox();
    b.add(failed("act-1"), 1);
    expect(hash(b)).not.toBe(base);
    b.take();
    expect(hash(b)).toBe(base);
  });
});
