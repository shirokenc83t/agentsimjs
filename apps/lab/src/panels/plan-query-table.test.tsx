import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryRow } from "./plan-queries.ts";
import { PlanQueryTable, StrategyRow } from "./plan-query-table.tsx";

// jsdom has no layout: the virtualizer reads the scroller's size from offsetWidth/offsetHeight.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 224 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 400 });
});

const row = (n: number, over: Partial<QueryRow> = {}): QueryRow => ({
  queryId: `q-${n}`,
  agentId: "ugv-001",
  seq: n,
  status: "found",
  algorithm: "strategy:short-astar-long-hpa@1",
  submittedTick: 10 * n,
  completedTick: 10 * n + 4,
  expansionsCharged: 1200 + n,
  restarts: [],
  interruptions: 0,
  legs: [],
  strategy: undefined,
  waypoints: undefined,
  ...over,
});

const strategic = row(2, {
  strategy: {
    id: "short-astar-long-hpa",
    version: 1,
    hash: "abcd1234",
    thinned: undefined,
    selects: [{ path: "/root", branch: "else", values: { "dist.m": 310.5 } }],
    searches: [
      { path: "/root/else", role: "plain", algorithm: "hpa", weight: undefined, heuristic: "euclidean", stageBudget: undefined, expansions: 1200, result: "found", startedTick: 20, endedTick: 24, waypoints: [[1, 1], [60, 60]] },
    ],
  },
  restarts: [{ reason: "map_changed", spent: 40, interrupted: false, simTimeS: 2 }],
});

describe("PlanQueryTable (UI-SPEC: Strategy query table)", () => {
  it("says so when the agent has no queries yet", () => {
    render(<PlanQueryTable rows={[]} selected={undefined} onSelect={() => {}} />);
    expect(screen.getByTestId("plan-queries-empty")).toHaveTextContent("no planning queries yet");
  });

  it("one line per query with glyph and text for its state, ticks, expansions, restarts and interruptions", () => {
    const rows = [
      row(1),
      strategic,
      row(3, { status: "interrupted", completedTick: undefined, expansionsCharged: undefined, interruptions: 2, restarts: [{ reason: "map_changed", spent: 10, interrupted: true, simTimeS: 1 }] }),
      row(4, { status: "budget_exceeded" }),
      row(5, { status: "running", completedTick: undefined }),
    ];
    render(<PlanQueryTable rows={rows} selected={undefined} onSelect={() => {}} />);
    expect(screen.getByTestId("plan-query-row-q-1")).toHaveTextContent("✓");
    expect(screen.getByTestId("plan-query-row-q-1")).toHaveTextContent("found");
    expect(screen.getByTestId("plan-query-row-q-2")).toHaveTextContent("↻1");
    expect(screen.getByTestId("plan-query-row-q-2")).toHaveTextContent("tick 20→24");
    expect(screen.getByTestId("plan-query-row-q-2")).toHaveTextContent("1202 exp");
    expect(screen.getByTestId("plan-query-row-q-3")).toHaveTextContent("↯2");
    expect(screen.getByTestId("plan-query-row-q-3")).toHaveTextContent("interrupted");
    expect(screen.getByTestId("plan-query-row-q-4")).toHaveTextContent("✕");
    expect(screen.getByTestId("plan-query-row-q-4")).toHaveTextContent("budget_exceeded");
    expect(screen.getByTestId("plan-query-row-q-5")).toHaveTextContent("▶");
    expect(screen.getByTestId("plan-query-row-q-5")).toHaveTextContent("running");
  });

  it("selecting a row reports it; the selected row shows the branch with its condition values and each search", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<PlanQueryTable rows={[row(1), strategic]} selected={undefined} onSelect={onSelect} />);
    expect(screen.queryByTestId("plan-query-detail")).toBeNull();
    await userEvent.click(screen.getByTestId("plan-query-row-q-2"));
    expect(onSelect).toHaveBeenCalledWith("q-2");
    rerender(<PlanQueryTable rows={[row(1), strategic]} selected="q-2" onSelect={onSelect} />);
    expect(screen.getByTestId("plan-query-row-q-2")).toHaveAttribute("aria-selected", "true");
    const detail = screen.getByTestId("plan-query-detail");
    expect(within(detail).getByTestId("plan-query-select-0")).toHaveTextContent("/root → else");
    expect(within(detail).getByTestId("plan-query-select-0")).toHaveTextContent("dist.m = 310.5");
    expect(within(detail).getByTestId("plan-query-search-0")).toHaveTextContent("hpa");
    expect(within(detail).getByTestId("plan-query-search-0")).toHaveTextContent("1200 exp");
    expect(within(detail).getByTestId("plan-query-search-0")).toHaveTextContent("ticks 20→24");
    expect(within(detail).getByTestId("plan-query-search-0")).toHaveTextContent("found");
    expect(within(detail).getByTestId("plan-query-restart-0")).toHaveTextContent("map_changed");
  });

  it("condition values are shown to 3 decimals; the trace keeps the exact number", () => {
    const exact = row(9, { strategy: { ...strategic.strategy!, selects: [{ path: "/root", branch: 0, values: { "dist.m": 3.999998960527877 } }] } });
    render(<PlanQueryTable rows={[exact]} selected="q-9" onSelect={() => {}} />);
    expect(screen.getByTestId("plan-query-select-0")).toHaveTextContent("dist.m = 4");
  });

  it("a lazy query lists its legs with the tick each became ready", () => {
    const lazy = row(7, { legs: [{ index: 0, count: 3, last: false, tick: 12 }, { index: 1, count: 3, last: false, tick: 20 }] });
    render(<PlanQueryTable rows={[lazy]} selected="q-7" onSelect={() => {}} />);
    expect(screen.getByTestId("plan-query-leg-0")).toHaveTextContent("leg 1/3");
    expect(screen.getByTestId("plan-query-leg-0")).toHaveTextContent("tick 12");
    expect(screen.getByTestId("plan-query-leg-1")).toHaveTextContent("leg 2/3");
  });

  it("is virtualized: a thousand queries render a window of rows, not a thousand", () => {
    const many = Array.from({ length: 1000 }, (_, i) => row(i));
    render(<PlanQueryTable rows={many} selected={undefined} onSelect={() => {}} />);
    const rendered = screen.getAllByTestId(/^plan-query-row-/).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
  });

  it("keyboard: arrows move the selection", async () => {
    const onSelect = vi.fn();
    render(<PlanQueryTable rows={[row(1), row(2), row(3)]} selected="q-2" onSelect={onSelect} />);
    screen.getByTestId("plan-queries").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenLastCalledWith("q-3");
    await userEvent.keyboard("{ArrowUp}");
    expect(onSelect).toHaveBeenLastCalledWith("q-1");
  });
});

describe("StrategyRow: the agent's effective planner (ADR-0037, ADR-0028)", () => {
  const strategy = { id: "astar-then-hpa", version: 1, hash: "9f8e7d6c", root: { kind: "fallback", stages: [] } };
  it("names the strategy with version, hash and the level that supplied it; the tree is on demand", () => {
    render(<StrategyRow strategy={strategy} source="byAgent" />);
    expect(screen.getByTestId("inspector-strategy")).toHaveTextContent("strategy:astar-then-hpa@1");
    expect(screen.getByTestId("inspector-strategy")).toHaveTextContent("#9f8e7d6c");
    expect(screen.getByTestId("inspector-strategy")).toHaveTextContent("byAgent");
    expect(screen.getByTestId("inspector-strategy-tree")).toHaveTextContent('"fallback"');
  });
});
