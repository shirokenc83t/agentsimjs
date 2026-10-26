import { describe, expect, it } from "vitest";
import { foldLabel, foldLanes, FOLD_LANE } from "./lane-fold.ts";

const lanes = ["run", "uav-001", "ugv-001", "ugv-002", "ugv-003"];

describe("the lanes of a timeline", () => {
  it("fold the agents with no marks into one row that says how many, in the run's order for the others", () => {
    const f = foldLanes(lanes, [{ agentId: "ugv-001" }, { agentId: undefined }], false);
    expect(f.lanes).toEqual(["run", "ugv-001", FOLD_LANE]);
    expect(f.empty).toEqual(["uav-001", "ugv-002", "ugv-003"]);
    expect(foldLabel(f.empty.length, false)).toBe("3 agents with no marks ▸");
  });

  it("show every lane, with the fold row at the end to fold them again, when opened", () => {
    const f = foldLanes(lanes, [{ agentId: "ugv-001" }], true);
    expect(f.lanes).toEqual([...lanes, FOLD_LANE]);
    expect(foldLabel(f.empty.length, true)).toContain("fold them");
  });

  it("leave one empty lane as it is: a fold of one row would take the room of the row it folds", () => {
    const f = foldLanes(["run", "a", "b"], [{ agentId: "a" }], false);
    expect(f.lanes).toEqual(["run", "a", "b"]);
    expect(f.empty).toEqual([]);
  });

  it("keep the lanes as they are when every agent has marks", () => {
    expect(foldLanes(lanes, lanes.map((l) => ({ agentId: l })), false).lanes).toEqual(lanes);
  });
});
