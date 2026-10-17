import { describe, expect, it } from "vitest";
import type { QueryRow, SearchView } from "./plan-queries.ts";
import { sandboxLines, sandboxRow, selectedQueryRow, stageLinesOf } from "./stage-lines.ts";

const search = (role: string, waypoints: [number, number][] | undefined, over: Partial<SearchView> = {}): SearchView => ({
  path: "/root",
  role,
  algorithm: "astar",
  weight: undefined,
  heuristic: "octile",
  stageBudget: undefined,
  expansions: 10,
  result: waypoints ? "found" : "not_found",
  startedTick: 1,
  endedTick: 2,
  waypoints,
  ...over,
});
const row = (id: string, searches: SearchView[] | undefined, over: Partial<QueryRow> = {}): QueryRow => ({
  queryId: id,
  agentId: "ugv-001",
  seq: Number(id.replace(/\D/g, "")),
  status: "found",
  algorithm: undefined,
  submittedTick: 1,
  completedTick: 5,
  expansionsCharged: 10,
  restarts: [],
  interruptions: 0,
  legs: [],
  strategy: searches ? { id: "s", version: 1, hash: "h", selects: [], searches, thinned: undefined } : undefined,
  waypoints: undefined,
  ...over,
});

describe("stageLinesOf: what the overlay draws for a query", () => {
  it("a refine: the coarse path, then each leg in order, as x, y pairs", () => {
    const lines = stageLinesOf(
      row("q-1", [
        search("coarse", [[0, 0], [50, 50]]),
        search("leg", [[0, 0], [10, 10]]),
        search("leg", [[10, 10], [50, 50]]),
      ]),
    );
    expect(lines.map((l) => l.role)).toEqual(["coarse", "leg", "leg"]);
    expect(Array.from(lines[1]?.points ?? [])).toEqual([0, 0, 10, 10]);
  });

  it("searches that found nothing have no geometry and are skipped (a fallback's failed first stage)", () => {
    const lines = stageLinesOf(row("q-1", [search("plan", undefined, { algorithm: "astar", result: "budget_exceeded" }), search("plan", [[1, 1], [9, 9]], { algorithm: "hpa" })]));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.role).toBe("leg");
  });

  it("anytime: only the last pass that found a path is drawn (earlier ones are superseded)", () => {
    const lines = stageLinesOf(row("q-1", [search("pass", [[0, 0], [9, 9]]), search("pass", [[0, 0], [5, 9], [9, 9]]), search("pass", undefined)]));
    expect(lines).toHaveLength(1);
    expect(Array.from(lines[0]?.points ?? [])).toEqual([0, 0, 5, 9, 9, 9]);
  });

  it("a plain query (no strategy) has no stages: the planned path is drawn by the path layer", () => {
    expect(stageLinesOf(row("q-1", undefined, { waypoints: [[0, 0], [1, 1]] }))).toEqual([]);
  });

  it("an interrupted or running query has no recorded geometry (its plan record never came)", () => {
    expect(stageLinesOf(row("q-1", undefined, { status: "interrupted" }))).toEqual([]);
    expect(stageLinesOf(undefined)).toEqual([]);
  });
});

describe("selectedQueryRow: the query the overlay follows", () => {
  const rows = [row("q-1", [search("plan", [[0, 0], [1, 1]])]), row("q-2", undefined), row("q-3", [search("plan", [[0, 0], [2, 2]])]), row("q-4", undefined, { status: "interrupted" })];

  it("the selected query of this agent, when there is one", () => {
    expect(selectedQueryRow(rows, { agentId: "ugv-001", queryId: "q-1" })?.queryId).toBe("q-1");
  });

  it("otherwise the latest query with stages (what the agent just did), not an interrupted one without geometry", () => {
    expect(selectedQueryRow(rows, undefined)?.queryId).toBe("q-3");
    expect(selectedQueryRow(rows, { agentId: "someone-else", queryId: "q-1" })?.queryId).toBe("q-3");
    expect(selectedQueryRow(rows, { agentId: "ugv-001", queryId: "q-9" })?.queryId).toBe("q-3");
  });

  it("nothing when no query has stages", () => {
    expect(selectedQueryRow([row("q-2", undefined)], undefined)).toBeUndefined();
  });
});

describe("the Strategy test as a row and as lines", () => {
  const base = { map: "belief" as const, status: "found" as const, planner: "strategy:s@1", ticks: 7, expansionsCharged: 120, waypoints: [[0, 0], [30, 30]] as [number, number][], legs: [], strategy: undefined };

  it("a result with a strategy trace is a row like a run's query: the same detail view, the same stages", () => {
    const strategy = { id: "s", version: 1, hash: "h", selects: [], searches: [{ path: "/root", role: "coarse", algorithm: "hpa", heuristic: "euclidean", expansions: 5, result: "found", startedTick: 1, endedTick: 1, waypoints: [[0, 0], [30, 30]] }] };
    const r = sandboxRow("ugv-001", { ...base, strategy: strategy as never, legs: [{ index: 0, count: 2, last: false, tick: 3, waypoints: [[0, 0], [10, 10]] }] });
    expect(r).toMatchObject({ queryId: "test", agentId: "ugv-001", status: "found", completedTick: 7, expansionsCharged: 120 });
    expect(r.strategy?.searches[0]?.role).toBe("coarse");
    expect(r.legs).toEqual([{ index: 0, count: 2, last: false, tick: 3 }]);
    expect(sandboxLines({ ...base, strategy: strategy as never }).map((l) => l.role)).toEqual(["coarse"]);
  });

  it("a plain algorithm has no trace: its path is drawn as one leg", () => {
    const lines = sandboxLines({ ...base, planner: "hpa" });
    expect(lines.map((l) => l.role)).toEqual(["leg"]);
    expect(Array.from(lines[0]?.points ?? [])).toEqual([0, 0, 30, 30]);
  });

  it("a failed search draws nothing", () => {
    expect(sandboxLines({ ...base, status: "not_found", waypoints: [] })).toEqual([]);
  });
});
