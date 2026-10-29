import { useUiContext } from "@agentsim/ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MissionProgress, MissionTooltip } from "./mission-progress.tsx";
import type { MissionView } from "./mission-view.ts";

// The Mission section of the Inspector: one row per step with its glyph and state in words, the stop leading in one line, a click selecting the step's decision record.

const step = (index: number, action: string, state: MissionView["steps"][number]["state"], more: object = {}) => ({ index, action, args: undefined, state, detail: undefined, words: undefined, code: undefined, startedAtS: undefined, endedAtS: undefined, durationS: undefined, decisionId: undefined, decisionSeq: undefined, ...more });
const VIEW: MissionView = {
  of: 3,
  current: 2,
  status: "stopped",
  steps: [step(0, "takeoff", "done", { durationS: 4, startedAtS: 0, endedAtS: 4, decisionSeq: 7 }), step(1, "explore", "preempted", { words: "preempted by the battery reflex · battery at 15.0 % (critical 15 %)", code: "battery_critical", decisionSeq: 12, startedAtS: 4, endedAtS: 38, durationS: 34 }), step(2, "returnToBase", "skipped")],
  stop: { step: 2, action: "explore", status: "preempted", code: "preempted", cause: "preempted by the battery reflex", line: "Mission stopped at step 2 of 3 · explore preempted at 38.0 s by the battery reflex · battery at 15.0 % (critical 15 %) · explore does not resume · step 3 not run" },
};

describe("the Mission section of the Inspector", () => {
  it("leads with the stop in words and lists each step with its glyph, state and duration", () => {
    render(<MissionProgress agentId="uav-001" runId="run-1" view={VIEW} />);
    expect(screen.getByTestId("mp-stop")).toHaveTextContent("Mission stopped at step 2 of 3 · explore preempted at 38.0 s by the battery reflex");
    expect([0, 1, 2].map((i) => screen.getByTestId(`mp-glyph-${i}`).textContent)).toEqual(["✓", "▲", "–"]);
    expect(screen.getByTestId("mp-row-1")).toHaveTextContent("preempted");
    expect(screen.getByTestId("mp-why-1")).toHaveTextContent("preempted by the battery reflex · battery at 15.0 % (critical 15 %)");
    expect(screen.getByTestId("mp-why-1")).toHaveAttribute("title", "battery_critical"); // the code is in the tooltip
    expect(screen.getByTestId("mp-stop")).not.toHaveTextContent("battery_critical");
    expect(screen.getByTestId("mp-row-0")).toHaveTextContent("4.0 s");
    expect(screen.getByTestId("mp-row-2")).toHaveTextContent("not run");
  });

  it("selects the step's decision record on a click; a step never begun has none to select", async () => {
    render(<MissionProgress agentId="uav-001" runId="run-1" view={VIEW} />);
    await userEvent.click(screen.getByRole("button", { name: /Step 2, explore/ }));
    expect(useUiContext.getState().selectedRecord).toEqual({ runId: "run-1", seq: 12 });
    expect(screen.getByRole("button", { name: /Step 3, returnToBase/ })).toBeDisabled();
  });

  it("the Scene tooltip lists every step with its state and the stop in words", () => {
    render(<MissionTooltip view={VIEW} />);
    expect(screen.getByTestId("map-tooltip-mission")).toHaveTextContent("mission 2 / 3 · stopped");
    expect(screen.getByTestId("map-tooltip-step-0")).toHaveTextContent("✓ 1 takeoff");
    expect(screen.getByTestId("map-tooltip-step-1")).toHaveTextContent("▲ 2 explore");
    expect(screen.getByTestId("map-tooltip-step-2")).toHaveTextContent("– 3 returnToBase");
    expect(screen.getByTestId("map-tooltip-mission")).toHaveTextContent("Mission stopped at step 2 of 3");
  });
});
