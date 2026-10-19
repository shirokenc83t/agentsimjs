import { describe, expect, it } from "vitest";
import { defaultReflexes } from "../reflexes/builtin.ts";
import type { SimAgent } from "./agent.ts";
import { ActionRuntime } from "./runtime.ts";
import { CollectingTrace, fakeCapabilities, FakeContact, FakePlanner, FakeProximity, FakeSpatial, makeUgv } from "./testing/fakes.ts";

const DT = 0.1;
const self = (a: SimAgent) => ({ scope: "self" as const, id: a.id });

function env() {
  const spatial = new FakeSpatial();
  const planner = new FakePlanner(spatial);
  const trace = new CollectingTrace();
  const rt = new ActionRuntime({ planner, spatial, capabilities: fakeCapabilities, trace, reflexes: defaultReflexes(), proximity: new FakeProximity(spatial, 2), contact: new FakeContact() }, DT);
  return { spatial, planner, trace, rt };
}

interface EscapeRecord {
  readonly kind: string;
  readonly ok?: boolean;
  readonly reason: string;
  readonly cells?: [number, number][];
  readonly distanceM?: number;
  readonly recoveries?: number;
}

/** A vehicle 0.6 m from the south face of a long wall to its north (planning clearance 0.75 m, bare footprint 0.5 m). */
function alongWall(y: number, x0 = 0, x1 = 40, drive: "differential" | "forward-only" = "differential", reverseAllowed = true) {
  const e = env();
  e.spatial.add({ x0, y0: y, x1, y1: y + 1 }); // the wall
  const a = makeUgv(20, y - 0.6, 0, { drive, reverseAllowed, turningRadiusM: 0 });
  e.rt.start(a, "goTo", { xM: 20, yM: y - 12 }, self(a), 0, 0);
  let minClear = Number.POSITIVE_INFINITY;
  for (let t = 0; t < 3000 && e.rt.isRunning(a.id); t++) {
    e.planner.advance(t);
    e.rt.tick(a, t, t * DT);
    minClear = Math.min(minClear, e.spatial.groundClearanceM(a.state.x, a.state.y, 5));
  }
  return { ...e, a, minClear };
}

describe("escape from the planning band (ADR-0033 addition of 2026-10-12)", () => {
  it("a vehicle inside its band along a long wall escapes away from the wall (where no straight reverse would leave it) and goes on", () => {
    const { trace, a, rt, minClear } = alongWall(30);
    const recs = trace.ops("recovery") as EscapeRecord[];
    expect(recs.some((r) => r.kind === "back-off")).toBe(false); // the escape comes first (ADR-0041): no reverse is even tried
    const escape = recs.find((r) => r.kind === "escape");
    expect(escape).toMatchObject({ reason: "inside_planning_clearance", recoveries: 1 });
    expect(escape?.ok).toBeUndefined();
    expect(escape?.cells?.length).toBeGreaterThan(1);
    expect(rt.info(a.id)?.status).toBe("succeeded");
    expect(minClear).toBeGreaterThanOrEqual(a.body.footprintRadiusM);
  });

  it("the escape path never lets clearance decrease and keeps the bare footprint free (property over wall layouts)", () => {
    let escapes = 0;
    for (let k = 0; k < 24; k++) {
      // Deterministic layouts: wall height and length vary, and a second obstacle sometimes sits to one side.
      const y = 20 + (k % 6) * 3;
      const e = env();
      e.spatial.add({ x0: 10 + (k % 4), y0: y, x1: 30 + (k % 5) * 4, y1: y + 0.5 + (k % 3) });
      if (k % 2 === 0) e.spatial.add({ x0: 8 + (k % 7), y0: y - 3, x1: 9 + (k % 7), y1: y - 1 });
      const a = makeUgv(20, y - 0.55 - (k % 3) * 0.05, 0, { drive: "differential", reverseAllowed: true, turningRadiusM: 0 });
      e.rt.start(a, "goTo", { xM: 20, yM: y - 12 }, self(a), 0, 0);
      for (let t = 0; t < 600 && e.rt.isRunning(a.id); t++) {
        e.planner.advance(t);
        e.rt.tick(a, t, t * DT);
      }
      for (const r of e.trace.ops("recovery") as EscapeRecord[]) {
        if (r.kind !== "escape" || r.ok === false || !r.cells) continue;
        escapes++;
        const cl = r.cells.map(([x, y]) => e.spatial.groundClearanceM(x, y, 5));
        for (let i = 0; i < cl.length; i++) expect(cl[i], `layout ${k} cell ${i}`).toBeGreaterThanOrEqual(a.body.footprintRadiusM - 1e-6);
        for (let i = 1; i < cl.length; i++) expect(cl[i] ?? 0, `layout ${k} cell ${i}`).toBeGreaterThanOrEqual((cl[i - 1] ?? 0) - 1e-6);
        expect(cl.at(-1) ?? 0).toBeGreaterThanOrEqual(a.body.footprintRadiusM + (a.body as { trackingMarginM: number }).trackingMarginM + 0.05 - 1e-6); // ends outside the band
        expect(r.distanceM).toBeLessThanOrEqual(3.5); // within the 3 m lattice radius (diagonals included)
      }
    }
    expect(escapes).toBeGreaterThan(5); // the property is exercised
  });

  it("is deterministic: the same situation gives the same escape path", () => {
    const first = (alongWall(30).trace.ops("recovery") as EscapeRecord[]).find((r) => r.kind === "escape");
    const second = (alongWall(30).trace.ops("recovery") as EscapeRecord[]).find((r) => r.kind === "escape");
    expect(first?.cells).toEqual(second?.cells);
    expect(first?.cells).toBeDefined();
  });

  it("a forward-only vehicle keeps its F1 behaviour: no recovery of any kind", () => {
    const { trace } = alongWall(30, 0, 40, "forward-only", false);
    expect(trace.ops("recovery")).toEqual([]);
  });

  it("a vehicle whose bare footprint already touches an obstacle on its map has nowhere to escape to: it fails without moving", () => {
    const e = env();
    e.spatial.add({ x0: 0, y0: 30, x1: 40, y1: 31 });
    const a = makeUgv(20, 29.7, 0, { drive: "differential", reverseAllowed: true, turningRadiusM: 0 }); // 0.3 m < the 0.5 m footprint
    e.rt.start(a, "goTo", { xM: 20, yM: 10 }, self(a), 0, 0);
    for (let t = 0; t < 50 && e.rt.isRunning(a.id); t++) {
      e.planner.advance(t);
      e.rt.tick(a, t, t * DT);
    }
    expect(e.rt.info(a.id)?.failure?.code).toBe("kinematically_infeasible");
    expect((e.trace.ops("recovery") as EscapeRecord[]).find((r) => r.kind === "escape")).toMatchObject({ ok: false });
    expect([a.state.x, a.state.y]).toEqual([20, 29.7]);
  });
});
