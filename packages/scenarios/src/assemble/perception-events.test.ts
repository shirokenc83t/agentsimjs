import { runLockstep } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { parseRunConfigValue } from "../run-config/resolve.ts";
import { buildReferenceRun } from "../testing/reference-run.ts";

const UNKNOWN = { beliefs: { default: { init: "unknown" as const } } };

const eventsOf = (run: ReturnType<typeof buildReferenceRun>, source: string, kind: string) =>
  run.trace
    .all()
    .filter((r) => r.source === source && r.kind === "event" && (r.payload as { op?: string }).op === "event" && (r.payload as { event: { kind: string } }).event.kind === kind)
    .map((r) => ({ simTime: r.simTime, event: (r.payload as { event: Record<string, unknown> }).event }));

describe("perception and discovery events (ADR-0005 addition of 2026-10-09)", () => {
  it("hysteresis: an entity seen intermittently with gaps shorter than lostAfterS raises one detected and no lost; a longer gap raises lost once; seeing it again raises detected", async () => {
    const run = buildReferenceRun({
      ...{ runConfig: UNKNOWN },
      scripts: {},
      objects: [{ id: "tgt", kind: "target", position: { xM: 14, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } }],
    });
    const rover = run.agents.find((a) => a.key === "rover");
    if (!rover || rover.kind !== "ugv") throw new Error("rover");
    const away = (ticks: number) => {
      const h = rover.state.heading;
      rover.state.heading = h + Math.PI; // facing away: the camera no longer sees it
      return runLockstep(run.world, run.scheduler, ticks).then(() => {
        rover.state.heading = h;
      });
    };
    await runLockstep(run.world, run.scheduler, 10);
    await away(15); // 1.5 s gap < 2 s
    await runLockstep(run.world, run.scheduler, 10);
    const id = `${rover.id}/sensors`;
    expect(eventsOf(run, id, "detected").filter((e) => e.event["entityId"] === "tgt")).toHaveLength(1);
    expect(eventsOf(run, id, "lost").filter((e) => e.event["entityId"] === "tgt")).toHaveLength(0);
    await away(35); // 3.5 s gap > 2 s
    await runLockstep(run.world, run.scheduler, 10);
    const lost = eventsOf(run, id, "lost").filter((e) => e.event["entityId"] === "tgt");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.event).toMatchObject({ entityKind: "target", transitions: 1 });
    expect(eventsOf(run, id, "detected").filter((e) => e.event["entityId"] === "tgt")).toHaveLength(2); // seen again after being lost
  });

  it("detected carries the entity's id and kind, from the agent's sensors (F2 idealization: perfect classification)", async () => {
    const run = buildReferenceRun({
      runConfig: UNKNOWN,
      scripts: {},
      objects: [{ id: "marker-1", kind: "marker", position: { xM: 13, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } }],
    });
    await runLockstep(run.world, run.scheduler, 30);
    const all = run.trace.all().filter((r) => r.kind === "event" && (r.payload as { op?: string }).op === "event" && (r.payload as { event: { kind: string } }).event.kind === "detected");
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => typeof (r.payload as { event: { entityKind: unknown } }).event.entityKind === "string")).toBe(true);
    expect(all.every((r) => r.source.endsWith("/sensors"))).toBe(true);
    expect(all.some((r) => (r.payload as { event: { entityId: string; entityKind: string } }).event.entityId === "marker-1" && (r.payload as { event: { entityKind: string } }).event.entityKind === "marker")).toBe(true);
  });

  it("frontierExhausted fires on the transition to no unmarked frontier, and re-arms when frontiers appear again", () => {
    const run = buildReferenceRun({ runConfig: UNKNOWN, scripts: {} });
    const rover = run.agents.find((a) => a.key === "rover");
    if (!rover) throw new Error("rover");
    const g = run.spatial.grid;
    const b = run.sensing.belief(rover.id);
    const topo = run.topology;
    const free = (i0: number, j0: number, i1: number, j1: number) => {
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) b.observeFree(i, j, 40);
    };
    const refresh = () => {
      run.planner.syncViews();
      topo.update(0);
    };
    const markAll = () => {
      for (const c of topo.candidates(rover.id)) topo.markAt(rover.id, c.xM, c.yM, 0);
      topo.update(0);
    };
    refresh();
    expect(topo.takeExhausted()).toEqual([]); // nothing known, nothing to exhaust (and never at tick 0)
    const ci = g.cellI(rover.state.x);
    const cj = g.cellJ(rover.state.y);
    free(ci - 10, cj - 10, ci + 10, cj + 10); // the area around the rover becomes known: a ring of frontiers
    refresh();
    expect(topo.candidates(rover.id).length).toBeGreaterThan(0);
    expect(topo.takeExhausted()).toEqual([]); // frontiers exist: armed, no event
    markAll(); // every group found unreachable: none left
    expect(topo.takeExhausted()).toEqual([rover.id]);
    topo.update(0);
    expect(topo.takeExhausted()).toEqual([]); // once per transition
    // New, unmarked frontiers appear elsewhere (the map grows): it re-arms and can fire again.
    free(ci + 30, cj + 30, ci + 36, cj + 36);
    refresh();
    expect(topo.candidates(rover.id).length).toBeGreaterThan(0);
    expect(topo.takeExhausted()).toEqual([]);
    markAll();
    expect(topo.takeExhausted()).toEqual([rover.id]);
  });

  it("an ideal agent never raises frontierExhausted (it has no frontiers)", async () => {
    const run = buildReferenceRun({ scripts: {} });
    await runLockstep(run.world, run.scheduler, 50);
    expect(run.trace.all().some((r) => r.kind === "event" && (r.payload as { event?: { kind: string } }).event?.kind === "frontierExhausted")).toBe(false);
  });

  it("minDecisionIntervalS: default 1 s, range [0, 600], in the effective hash but in the run-config hash only when set", async () => {
    const base = buildReferenceRun({ scripts: {} });
    expect(base.resolved.minDecisionIntervalS).toBe(1);
    const explicitDefault = buildReferenceRun({ scripts: {}, runConfig: { minDecisionIntervalS: 1 } });
    expect(explicitDefault.resolved.runConfigHash).toBe(base.resolved.runConfigHash);
    const longer = buildReferenceRun({ scripts: {}, runConfig: { minDecisionIntervalS: 5 } });
    expect(longer.resolved.runConfigHash).not.toBe(base.resolved.runConfigHash);
    expect(longer.resolved.effectiveConfigHash).not.toBe(base.resolved.effectiveConfigHash);
    const doc = (v: number) => ({ schemaVersion: 0, scenario: { id: "f1-reference", version: 1 }, minDecisionIntervalS: v });
    expect(parseRunConfigValue(doc(0)).ok).toBe(true);
    expect(parseRunConfigValue(doc(600)).ok).toBe(true);
    expect(parseRunConfigValue(doc(-1)).ok).toBe(false);
    expect(parseRunConfigValue(doc(601)).ok).toBe(false);
  });
});
