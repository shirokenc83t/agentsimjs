import { runLockstep, type Brain, type DecisionRequest } from "@agentsim/core";
import { describe, expect, it } from "vitest";
import { buildReferenceRun, type ReferenceRunOptions } from "../testing/reference-run.ts";
import { watchTruth } from "../testing/truth-watch.ts";

const UNKNOWN: ReferenceRunOptions["runConfig"] = { beliefs: { default: { init: "unknown" } } };

/** Answers every request with `explore` when idle, so the belief map grows. */
class Explorer implements Brain {
  readonly tier = "baseline" as const;
  constructor(readonly id = "explorer") {}
  decide(req: DecisionRequest) {
    return Promise.resolve({ decision: req.self.running === null ? { kind: "action" as const, name: "explore", params: {} } : { kind: "idle" as const } });
  }
}

type Run = ReturnType<typeof buildReferenceRun>;
const make = (o: ReferenceRunOptions = {}): Run => buildReferenceRun({ runConfig: UNKNOWN, scripts: {}, beliefVsTruth: { everyS: 10 }, ...o });
const roverId = (r: Run): string => {
  const a = r.agents.find((x) => x.key === "rover");
  if (!a) throw new Error("no rover");
  return a.id;
};
const obs = (r: Run) => {
  if (!r.observer) throw new Error("no observer");
  return r.observer;
};
const mapOf = (r: Run, tick = 0, t = 0) => {
  const m = obs(r).report(roverId(r), tick, t).map;
  if (!m) throw new Error("no map metrics");
  return m;
};
const pct2 = (a: number, b: number) => Math.round((10000 * a) / b) / 100;

describe("beliefVsTruth (ADR-0005 addition of 2026-10-11): observer-side metrics", () => {
  it("an agent that knows nothing: every reachable cell unknown, nothing wrong", () => {
    const m = mapOf(make());
    expect(m.reachableCells).toBeGreaterThan(0);
    expect(m.unknownPct).toBe(100);
    expect(m.correctPct).toBe(0);
    expect(m.phantomPct).toBe(0);
    expect(m.falseFreeCells).toBe(0);
  });

  it("known, phantom and false-free cells are told apart, and counted per the definitions", () => {
    const run = make();
    const belief = run.sensing.belief(roverId(run));
    const cells = mapOf(run).reachableCells;
    // 10 truly free cells believed free (correct); 5 truly free cells believed occupied (phantom); 3 wall cells believed free.
    for (let i = 20; i < 30; i++) belief.observeFree(i, 30, 40);
    for (let i = 20; i < 25; i++) belief.observeHit(i, 40, 0, 40);
    for (let j = 10; j < 13; j++) {
      expect(run.spatial.grid.isBlocked(60, j)).toBe(true);
      belief.observeFree(60, j, 40);
    }
    const m = mapOf(run, 1, 0.1);
    expect(m.reachableCells).toBe(cells);
    expect(m.correctPct).toBe(pct2(10, cells));
    expect(m.phantomPct).toBe(pct2(5, cells));
    expect(m.unknownPct).toBe(pct2(cells - 15, cells));
    expect(m.falseFreeCells).toBe(3);
    expect(m.falseFreePct).toBe(pct2(3, 13)); // of the 13 cells believed free
  });

  it("the sealed box is not reachable: knowing it changes nothing", () => {
    const run = make();
    const belief = run.sensing.belief(roverId(run));
    const cells = mapOf(run).reachableCells;
    const g = run.spatial.grid;
    expect(cells).toBeLessThan(g.sizeX * g.sizeY);
    // The closed box of the reference world: its interior is not in the rover's component.
    expect(g.isBlocked(90, 90)).toBe(true);
    expect(g.isBlocked(100, 90)).toBe(false);
    for (let i = 95; i < 105; i++) belief.observeFree(i, 90, 40);
    const m = mapOf(run, 1, 0.1);
    expect(m.reachableCells).toBe(cells);
    expect(m.correctPct).toBe(0);
  });

  it("exploring improves it, never makes cells wrong with perfect sensing, and the incremental tallies equal a full recount", async () => {
    const run = make({ brains: { rover: new Explorer() } });
    let prevKnown = 0;
    for (let k = 0; k < 8; k++) {
      await runLockstep(run.world, run.scheduler, 50);
      const m = mapOf(run);
      expect(m.phantomPct).toBe(0);
      expect(m.falseFreeCells).toBe(0);
      expect(m.correctPct + m.phantomPct + m.unknownPct).toBeCloseTo(100, 1);
      expect(100 - m.unknownPct).toBeGreaterThanOrEqual(prevKnown);
      prevKnown = 100 - m.unknownPct;
      obs(run).recompute(roverId(run));
      expect(mapOf(run)).toEqual(m);
    }
    expect(prevKnown).toBeGreaterThan(0);
  });

  it("entities: known over total, with the position error of what is known", async () => {
    const run = make({
      objects: [
        { id: "near", kind: "marker", position: { xM: 14, yM: 10 }, size: { radiusM: 0.3, heightM: 1 } },
        { id: "far", kind: "marker", position: { xM: 60, yM: 20 }, size: { radiusM: 0.3, heightM: 1 } },
      ],
    });
    await runLockstep(run.world, run.scheduler, 40);
    const e = obs(run).report(roverId(run), 40, 4).entities;
    expect(e.total).toBe(2 + 2); // two objects and the two other agents
    expect(e.known).toBeGreaterThanOrEqual(1);
    expect(e.known).toBeLessThan(e.total);
    expect(e.maxErrM).toBeLessThan(1);
  });

  it("ideal agents have no map metrics (their map is the truth) and still have entity metrics", () => {
    const run = buildReferenceRun({ scripts: {}, beliefVsTruth: { everyS: 10 } });
    const r = obs(run).report(roverId(run), 0, 0);
    expect(r.map).toBeUndefined();
    expect(r.entities.total).toBe(2);
  });

  it("is sampled into the trace every 10 s of sim time per agent, from world/sim, with the agents' phases spread over the interval", async () => {
    const run = make();
    await runLockstep(run.world, run.scheduler, 250);
    const recs = run.trace.all().filter((r) => (r.payload as { op?: string }).op === "belief-vs-truth");
    expect(recs.every((r) => r.source === "world/sim")).toBe(true);
    const byAgent = new Map<string, number[]>();
    for (const r of recs) byAgent.set(r.agentId ?? "", [...(byAgent.get(r.agentId ?? "") ?? []), r.simTime]);
    expect(byAgent.size).toBe(3);
    const firsts: number[] = [];
    for (const times of byAgent.values()) {
      expect(times.length).toBeGreaterThanOrEqual(2);
      firsts.push(times[0] as number);
      for (let k = 1; k < times.length; k++) expect((times[k] as number) - (times[k - 1] as number)).toBeCloseTo(10, 0);
    }
    expect(new Set(firsts).size).toBe(3); // three different phases: never all agents on one tick
  });

  it("a UAV is judged by its own rules: a wall cell believed free is a false free at its altitude", () => {
    const run = make();
    const scout = run.agents.find((a) => a.key === "scout");
    if (!scout) throw new Error("no scout");
    const belief = run.sensing.belief(scout.id);
    const before = obs(run).report(scout.id, 0, 0).map;
    expect(before?.unknownPct).toBeGreaterThan(90);
    expect(run.spatial.grid.isBlocked(60, 50)).toBe(true);
    belief.observeFree(60, 50, 40);
    const after = obs(run).report(scout.id, 1, 0.1).map;
    expect(after?.falseFreeCells).toBe(1);
    expect(after?.heightViolations).toBe(0);
  });

  it("does not change the run: same state hash with and without the observer", async () => {
    const a = buildReferenceRun({ runConfig: UNKNOWN, scripts: {}, brains: { rover: new Explorer() } });
    const b = make({ brains: { rover: new Explorer() } });
    await runLockstep(a.world, a.scheduler, 300);
    await runLockstep(b.world, b.scheduler, 300);
    expect(b.world.stateHash).toBe(a.world.stateHash);
  });
});

describe("beliefVsTruth never reaches a mind (ADR-0005 addition of 2026-10-11)", () => {
  it("every built request carries no such field and no metric value", async () => {
    const seen: DecisionRequest[] = [];
    const mind: Brain = {
      id: "capture",
      tier: "baseline",
      decide(req) {
        seen.push(req);
        return Promise.resolve({ decision: req.self.running === null ? { kind: "action" as const, name: "explore", params: {} } : { kind: "idle" as const } });
      },
    };
    const run = make({ brains: { rover: mind } });
    await runLockstep(run.world, run.scheduler, 400);
    const m = mapOf(run);
    expect(seen.length).toBeGreaterThan(2);
    for (const req of seen) expect(JSON.stringify(req)).not.toMatch(/beliefVsTruth|belief-vs-truth|phantom|falseFree|heightViolations|reachableCells|meanErrM|unknownPct|tickBudgetUse|planBudgetUse|backlogRecords|sim.tickMs|agent.soc/);
    // The metrics are real, so the scan above means something.
    expect(m.reachableCells).toBeGreaterThan(1000);
  });

  it("building a request reads no ground-truth cell; the observer, the ground-truth side, does (positive control)", async () => {
    const run = make();
    await runLockstep(run.world, run.scheduler, 30);
    const truth = watchTruth(run.spatial);
    truth.during(() => run.mindView.view(roverId(run), 3));
    expect(truth.hits).toEqual([]);
    truth.during(() => {
      obs(run).recompute(roverId(run));
      obs(run).report(roverId(run), 0, 0);
    });
    expect(truth.hits.length).toBeGreaterThan(0);
  });

  it("beliefAt: what every agent believes of one cell, from its own map, the agents whose map is the truth as ideal; nothing changes", () => {
    const run = make();
    const rover = roverId(run);
    const belief = run.sensing.belief(rover);
    belief.observeFree(25, 30, 40);
    belief.observeHit(26, 30, 0, 40);
    const free = obs(run).beliefAt(25, 30).find((a) => a.agentId === rover);
    const occupied = obs(run).beliefAt(26, 30).find((a) => a.agentId === rover);
    const unknown = obs(run).beliefAt(100, 100).find((a) => a.agentId === rover);
    expect([free?.state, occupied?.state, unknown?.state]).toEqual(["free", "occupied", "unknown"]);
    const all = obs(run).beliefAt(25, 30);
    expect(all.map((a) => a.agentId).sort()).toEqual(run.agents.map((a) => a.id).sort());
    // Reading again, and reading elsewhere, left the maps as they were.
    expect(obs(run).beliefAt(25, 30)).toEqual(all);
    // With every agent ideal, each one's belief is the truth.
    const ideal = make({ runConfig: { beliefs: { default: { init: "ideal" } } } });
    expect(obs(ideal).beliefAt(3, 3).every((a) => a.state === "ideal")).toBe(true);
  });
});
