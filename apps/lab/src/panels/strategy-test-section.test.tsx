import type { SimStrategyTestResultMessage } from "@agentsim/core";
import type { StrategyTestResult } from "@agentsim/scenarios";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SimClient } from "../sim/sim-client.ts";
import { sandboxTarget, sandboxView } from "./sandbox-store.ts";
import { StrategyTestSection } from "./strategy-test-section.tsx";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 224 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 400 });
});
afterEach(() => {
  sandboxView.set(undefined);
  sandboxTarget.cancelPicking();
});

const result = (over: Partial<StrategyTestResult> = {}): StrategyTestResult => ({
  map: "belief",
  status: "found",
  planner: "strategy:astar-then-hpa@1",
  ticks: 7,
  expansionsCharged: 120,
  waypoints: [[0, 0], [30, 40]],
  strategy: { id: "astar-then-hpa", version: 1, hash: "abcd1234", selects: [], searches: [{ path: "/root/stages/0", role: "plan", algorithm: "astar", heuristic: "octile", expansions: 120, result: "found", startedTick: 1, endedTick: 7, waypoints: [[0, 0], [30, 40]] }] } as never,
  legs: [],
  ...over,
});

function setup(answer: (req: Record<string, unknown>) => SimStrategyTestResultMessage) {
  const strategyTest = vi.fn((req: Record<string, unknown>) => Promise.resolve(answer(req)));
  const sim = { strategyTest } as unknown as SimClient;
  const { unmount } = render(<StrategyTestSection sim={sim} agentId="ugv-001" />);
  return { strategyTest, unmount };
}
const ok = (r: StrategyTestResult): SimStrategyTestResultMessage => ({ type: "strategyTestResult", requestId: 1, ok: true, result: r });
const typeTarget = async (x: string, y: string) => {
  await userEvent.clear(screen.getByTestId("st-x"));
  await userEvent.type(screen.getByTestId("st-x"), x);
  await userEvent.clear(screen.getByTestId("st-y"));
  await userEvent.type(screen.getByTestId("st-y"), y);
};

describe("StrategyTestSection: the researcher's Strategy test (ADR-0037 item 16)", () => {
  it("is labelled as a researcher tool and defaults to the agent's own planner on its belief map", () => {
    setup(() => ok(result()));
    expect(screen.getByTestId("inspector-strategy-test")).toHaveTextContent("researcher tool");
    expect((screen.getByTestId("st-strategy") as HTMLSelectElement).value).toBe("own");
    expect((screen.getByTestId("st-map") as HTMLSelectElement).value).toBe("belief");
    expect(screen.queryByTestId("st-researcher-banner")).toBeNull();
    expect(screen.getByTestId("st-run")).toBeDisabled(); // no target yet
  });

  it("sends the request: agent, target, map and the chosen preset; shows the answer with its detail", async () => {
    const { strategyTest } = setup(() => ok(result()));
    await userEvent.selectOptions(screen.getByTestId("st-strategy"), "astar-then-hpa@1");
    await typeTarget("30", "40");
    await userEvent.click(screen.getByTestId("st-run"));
    expect(strategyTest).toHaveBeenCalledWith({ agentId: "ugv-001", to: { xM: 30, yM: 40 }, planOn: "belief", strategy: { ref: "astar-then-hpa", version: 1 } });
    expect(await screen.findByTestId("st-status")).toHaveTextContent("✓ found");
    expect(screen.getByTestId("st-status")).toHaveTextContent("strategy:astar-then-hpa@1");
    expect(screen.getByTestId("st-status")).toHaveTextContent("7 ticks");
    expect(screen.getByTestId("st-status")).toHaveTextContent("50.0 m"); // the path (0,0)→(30,40)
    expect(screen.getByTestId("plan-query-detail")).toHaveTextContent("astar");
    expect(screen.getByTestId("st-source")).toHaveTextContent("belief map");
    expect(sandboxView.get()?.result.planner).toBe("strategy:astar-then-hpa@1"); // the Scene draws it
  });

  it("the agent's own planner is sent as no strategy at all", async () => {
    const { strategyTest } = setup(() => ok(result({ strategy: undefined, planner: "hpa" })));
    await typeTarget("5", "6");
    await userEvent.click(screen.getByTestId("st-run"));
    expect(strategyTest.mock.calls[0]?.[0]).not.toHaveProperty("strategy");
  });

  it("the ground truth is marked as researcher data, the belief map is not", async () => {
    setup((req) => ok(result({ map: req["planOn"] as "belief" | "truth" })));
    await typeTarget("5", "6");
    await userEvent.selectOptions(screen.getByTestId("st-map"), "truth");
    expect(screen.getByTestId("st-researcher-banner")).toHaveTextContent("Researcher view — not visible to the mind");
    await userEvent.click(screen.getByTestId("st-run"));
    expect(await screen.findByTestId("st-source")).toHaveTextContent("ground truth");
    await userEvent.selectOptions(screen.getByTestId("st-map"), "belief");
    expect(screen.queryByTestId("st-researcher-banner")).toBeNull();
  });

  it("an ideal agent's belief request comes back as truth: the banner follows what was actually planned on", async () => {
    setup(() => ok(result({ map: "truth" })));
    await typeTarget("5", "6");
    await userEvent.click(screen.getByTestId("st-run"));
    expect(await screen.findByTestId("st-result-researcher")).toHaveTextContent("Researcher view — not visible to the mind");
  });

  it("an inline strategy: JSON syntax is checked here, the worker's code and path come back as the error", async () => {
    const { strategyTest } = setup(() => ({ type: "strategyTestResult", requestId: 1, ok: false, error: { code: "expr_unknown_name", message: "unknown name nonsense", path: "/strategy/root/branches/0/when" } }));
    await userEvent.selectOptions(screen.getByTestId("st-strategy"), "inline");
    const text = screen.getByTestId("st-json");
    await userEvent.clear(text);
    await userEvent.paste("{ not json");
    expect(screen.getByTestId("st-json-error")).toHaveTextContent("invalid_json");
    await typeTarget("5", "6");
    expect(screen.getByTestId("st-run")).toBeDisabled();
    await userEvent.clear(text);
    await userEvent.paste(JSON.stringify({ schemaVersion: 0, id: "mine", version: 1, origin: "human", root: { kind: "algorithm", algorithm: "astar" } }));
    await userEvent.click(screen.getByTestId("st-run"));
    expect(strategyTest.mock.calls[0]?.[0]).toMatchObject({ strategy: { id: "mine" } });
    expect(await screen.findByTestId("st-error")).toHaveTextContent("expr_unknown_name");
    expect(screen.getByTestId("st-error")).toHaveTextContent("/strategy/root/branches/0/when");
    expect(sandboxView.get()).toBeUndefined();
  });

  it("a target picked on the map fills the fields; Clear removes the result from the Scene", async () => {
    setup(() => ok(result()));
    await userEvent.click(screen.getByTestId("st-pick"));
    expect(sandboxTarget.get().picking).toBe(true);
    expect(screen.getByTestId("inspector-strategy-test")).toHaveTextContent("Click a target");
    act(() => sandboxTarget.setTarget(12.5, 7));
    expect((screen.getByTestId("st-x") as HTMLInputElement).value).toBe("12.5");
    expect((screen.getByTestId("st-y") as HTMLInputElement).value).toBe("7");
    await userEvent.click(screen.getByTestId("st-run"));
    await screen.findByTestId("st-status");
    await userEvent.click(screen.getByTestId("st-clear"));
    expect(sandboxView.get()).toBeUndefined();
    expect(screen.queryByTestId("st-status")).toBeNull();
  });

  it("leaves the Scene clean when the section goes away (another agent selected)", async () => {
    const { unmount } = setup(() => ok(result()));
    await typeTarget("5", "6");
    await userEvent.click(screen.getByTestId("st-run"));
    await screen.findByTestId("st-status");
    expect(sandboxView.get()).toBeDefined();
    unmount();
    expect(sandboxView.get()).toBeUndefined();
  });
});
