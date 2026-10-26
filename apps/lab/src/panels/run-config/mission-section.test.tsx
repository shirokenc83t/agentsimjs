import type { RunConfigDocument } from "@agentsim/scenarios";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { missionOf } from "./mission-model.ts";
import { missionAgentsOf, MissionSection, type MissionAgent } from "./mission-section.tsx";

// The step editor (F3c M1): add, reorder, remove and undo steps; whether each can run along the list with the one-click fix; arguments checked in words; a point picked on the map.

const DOC = { schemaVersion: 0, scenario: { id: "f2-discovery", version: 1 } } as unknown as RunConfigDocument;
const SCOUT: MissionAgent = { id: "uav-001", key: "scout", kind: "uav", facts: { kind: "uav", airborne: false, soc: 1, hasBase: true, hasRangeSensor: true }, cruiseAltitudeM: 20, start: { x: 12, y: 12 }, base: { x: 5, y: 5 } };
const ROVER: MissionAgent = { id: "ugv-001", key: "rover", kind: "ugv", facts: { kind: "ugv", airborne: false, soc: 1, hasBase: true, hasRangeSensor: true }, cruiseAltitudeM: undefined, start: { x: 10, y: 10 }, base: { x: 5, y: 5 } };
const WORLD = { wM: 64, hM: 64 };
const RETURN_THEN_LAND = {
  ...DOC,
  minds: { byAgent: { scout: { s1: { script: { name: "sequence", params: { steps: [{ action: "takeoff", args: { altitudeM: 20 } }, { action: "returnToBase" }, { action: "land" }] } } } } } },
} as unknown as RunConfigDocument;

let latest: RunConfigDocument = DOC;
function Harness(props: { initial?: RunConfigDocument; agents?: MissionAgent[] }) {
  const [draft, setDraft] = useState(props.initial ?? DOC);
  latest = draft;
  return <MissionSection draft={draft} onChange={setDraft} agents={props.agents ?? [SCOUT, ROVER]} world={WORLD} pointedError={undefined} />;
}
const steps = () => missionOf(latest, "scout").map((s) => s.action);
const add = (name: string) => userEvent.selectOptions(screen.getByTestId("ms-add"), name);

describe("the mission step editor", () => {
  it("starts empty with a line that says what goes there, and adds steps from the actions the vehicle supports", async () => {
    render(<Harness />);
    expect(screen.getByTestId("ms-empty")).toHaveTextContent("No mission");
    await add("takeoff");
    await add("goTo");
    await add("explore");
    expect(steps()).toEqual(["takeoff", "goTo", "explore"]);
    expect(latest.minds?.byAgent?.["scout"]?.s1.script.name).toBe("sequence");
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("✓ valid · 3 steps · uav-001");
    expect(screen.getByTestId("ms-glyph-0")).toHaveTextContent("✓");
    expect(screen.getByTestId("ms-after-1")).toHaveTextContent("→ airborne · does not resume after a preemption");
  });

  it("lists an action the vehicle does not support greyed with the reason", async () => {
    render(<Harness />);
    await userEvent.selectOptions(screen.getByTestId("ms-agent"), "rover");
    const opt = within(screen.getByTestId("ms-add")).getByRole("option", { name: /takeoff/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    expect(opt.textContent).toContain("not offered for a ground vehicle");
  });

  it("says along the list that goTo needs airborne, and one click inserts the take off before it", async () => {
    render(<Harness />);
    await add("goTo");
    expect(screen.getByTestId("ms-hint-0")).toHaveTextContent("goTo needs airborne · take off first");
    expect(screen.getByTestId("ms-glyph-0")).toHaveTextContent("▲");
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("1 to fix");
    await userEvent.click(screen.getByTestId("ms-fix-0"));
    expect(steps()).toEqual(["takeoff", "goTo"]);
    expect(screen.queryByTestId("ms-hint-0")).toBeNull();
    expect(screen.queryByTestId("ms-hint-1")).toBeNull();
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("✓ valid");
  });

  it("says that a land after the return home is not needed, the return home already landed the UAV, and one click removes it", async () => {
    render(<Harness initial={RETURN_THEN_LAND} />);
    expect(screen.getByTestId("ms-hint-2")).toHaveTextContent("returnToBase already lands the UAV · remove this step · returnToBase left the UAV on the ground at step 2");
    await userEvent.click(screen.getByTestId("ms-fix-2"));
    expect(steps()).toEqual(["takeoff", "returnToBase"]);
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("✓ valid");
  });

  it("moves a step with its buttons and with Alt+Up, removes it with its button and with Delete, and undoes with Ctrl+Z", async () => {
    render(<Harness />);
    for (const n of ["takeoff", "goTo", "explore"]) await add(n);
    await userEvent.click(screen.getByTestId("ms-down-0"));
    expect(steps()).toEqual(["goTo", "takeoff", "explore"]);
    await userEvent.click(screen.getByTestId("ms-up-1"));
    expect(steps()).toEqual(["takeoff", "goTo", "explore"]);
    screen.getByTestId("ms-step-2").focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(steps()).toEqual(["takeoff", "explore", "goTo"]);
    await userEvent.keyboard("{Delete}"); // the moved step is the selected one
    expect(steps()).toEqual(["takeoff", "goTo"]);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(steps()).toEqual(["takeoff", "explore", "goTo"]);
    await userEvent.click(screen.getByTestId("ms-remove-0"));
    expect(steps()).toEqual(["explore", "goTo"]);
    await userEvent.click(screen.getByTestId("ms-clear"));
    expect(latest.minds).toBeUndefined();
  });

  it("checks the arguments as they are typed, in words, and an invalid list is not valid", async () => {
    render(<Harness />);
    await add("takeoff");
    await add("explore");
    const radius = screen.getByTestId("ms-arg-1-radiusM");
    await userEvent.type(radius, "0");
    expect(screen.getByTestId("ms-error-1")).toHaveTextContent("✕ step 2 · explore · radiusM 0 must be above 0");
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("1 to fix");
    await userEvent.clear(radius);
    await userEvent.type(radius, "25");
    expect(screen.queryByTestId("ms-error-1")).toBeNull();
    expect(missionOf(latest, "scout")[1]?.args).toEqual({ radiusM: 25 });
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("✓ valid");
  });

  it("picks the point of a go to on the map: the step is picked, the map clicked, the step holds the point and a pin is numbered", async () => {
    render(<Harness />);
    await add("takeoff");
    await add("goTo");
    await userEvent.click(screen.getByTestId("ms-pick-1"));
    const svg = screen.getByTestId("ms-map-svg");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 240, height: 240, right: 240, bottom: 240, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(svg, { clientX: 120, clientY: 60 });
    expect(missionOf(latest, "scout")[1]?.args).toEqual({ xM: 32, yM: 48 });
    expect(screen.getByTestId("ms-pin-1")).toHaveTextContent("2");
    expect(screen.getByTestId("ms-arg-1-xM")).toHaveValue("32");
  });

  it("copies a mission to another agent that supports every step, and not to one that does not", async () => {
    render(<Harness />);
    await add("hold");
    await add("explore");
    await userEvent.selectOptions(screen.getByTestId("ms-copy"), "rover");
    expect(missionOf(latest, "rover").map((s) => s.action)).toEqual(["hold", "explore"]);
    await userEvent.selectOptions(screen.getByTestId("ms-agent"), "scout");
    await add("takeoff");
    const rover = within(screen.getByTestId("ms-copy")).getByRole("option", { name: /ugv-001/ }) as HTMLOptionElement;
    expect(rover.disabled).toBe(true);
  });

  it("warns that steps behind a hold with no duration do not run", async () => {
    render(<Harness />);
    await add("takeoff");
    await add("hold");
    await add("explore");
    expect(screen.queryByTestId("ms-note-1")).toBeNull(); // a hold added with its five seconds ends
    await userEvent.clear(screen.getByTestId("ms-arg-1-durationS"));
    expect(screen.getByTestId("ms-note-1")).toHaveTextContent("never ends");
    expect(screen.getByTestId("ms-note-2")).toHaveTextContent("does not run");
    expect(screen.getByTestId("ms-valid")).toHaveTextContent("to fix");
  });

  it("offers nothing to an agent with no key and says why", () => {
    render(<Harness agents={[]} />);
    expect(screen.getByTestId("rc-mission")).toHaveTextContent("No agent has a key");
  });
});

describe("the agents a mission can be given", () => {
  it("are the ones with a key, with the state each starts in read from the stored scenario (airborne at a positive start altitude), its base and the world's extent", () => {
    const loaded = [
      { id: "ugv-001", key: "rover", kind: "ugv" as const },
      { id: "uav-001", key: "scout", kind: "uav" as const, config: { body: { cruiseAltitudeM: 25, sensors: [{ type: "lidar" }] } } },
      { id: "ugv-002", kind: "ugv" as const },
    ];
    const scenario = {
      world: { sizeCells: { x: 128, y: 128 }, resolutionM: 0.5 },
      agents: [
        { key: "rover", start: { xM: 5, yM: 5 } },
        { key: "scout", start: { xM: 12, yM: 12, zM: 20 }, base: { xM: 3, yM: 3 } },
      ],
    };
    const r = missionAgentsOf(loaded, scenario);
    expect(r.world).toEqual({ wM: 64, hM: 64 });
    expect(r.agents.map((a) => a.key)).toEqual(["rover", "scout"]);
    const scout = r.agents.find((a) => a.key === "scout") as MissionAgent;
    expect(scout.facts.airborne).toBe(true);
    expect(scout.cruiseAltitudeM).toBe(25);
    expect(scout.base).toEqual({ x: 3, y: 3 });
    expect(missionAgentsOf(loaded, undefined).world).toBeUndefined();
  });
});
