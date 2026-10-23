import { createMemoryPorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { loadInspectorLayout, storeInspectorLayout } from "../../config/inspector-layout.ts";
import { addPane, DEFAULT_PANES, filterAfterViewChange, filterFitsView, MAX_PANES, metricFilterFor, paneFor, removePane, sourceFilter, sourceTree, updatePane } from "./panes.ts";

describe("the panes of the multi-log inspector", () => {
  it("writes a source as a filter, and fits a filter to a view: records for a log or a table, samples for a series", () => {
    expect(sourceFilter("uav-001")).toBe("source:uav-001/*");
    expect(sourceFilter("uav-001", "planner")).toBe("source:uav-001/planner");
    expect(filterFitsView("kind:action", "log")).toBe(true);
    expect(filterFitsView("kind:action", "table")).toBe(true);
    expect(filterFitsView("kind:action", "series")).toBe(false);
    expect(filterFitsView("metric:agent.soc", "series")).toBe(true);
    expect(filterFitsView("metric:agent.soc", "log")).toBe(false);
    expect(filterFitsView("kind:nonsense", "log")).toBe(false);
    expect(filterFitsView("", "log")).toBe(true);
  });

  it("holds at most the limit, dropping the oldest, and replaces a pane that has the same id", () => {
    let panes = [...DEFAULT_PANES];
    for (let i = 0; i < MAX_PANES + 2; i++) panes = addPane(panes, paneFor(`n${i}`, "log", "", `n${i}`));
    expect(panes).toHaveLength(MAX_PANES);
    expect(panes.at(-1)?.id).toBe(`n${MAX_PANES + 1}`);
    expect(panes.some((p) => p.id === "p1")).toBe(false);
    expect(addPane(panes, paneFor("n5", "table", "kind:event", "again")).filter((p) => p.id === "n5")).toEqual([{ id: "n5", view: "table", filter: "kind:event", title: "again" }]);
  });

  it("removes and updates a pane", () => {
    const panes = [...DEFAULT_PANES];
    expect(removePane(panes, "p1").map((p) => p.id)).toEqual(["p2"]);
    expect(updatePane(panes, "p1", { filter: "kind:event" })[0]).toMatchObject({ id: "p1", filter: "kind:event", view: "log" });
  });

  it("a filter that does not fit the new view becomes that view's own start", () => {
    expect(filterAfterViewChange("kind:action", "table")).toBe("kind:action");
    expect(filterAfterViewChange("kind:action", "series")).toBe("metric:agent.soc");
    expect(filterAfterViewChange("metric:sim.tickMs", "log")).toBe("-source:*/body");
    expect(filterAfterViewChange("metric:sim.tickMs", "series")).toBe("metric:sim.tickMs");
  });

  it("makes the source tree of the agents and the world, with the components their owner has; and the metrics a node offers", () => {
    const tree = sourceTree(["uav-001", "ugv-001"]);
    expect(tree.map((n) => n.owner)).toEqual(["uav-001", "ugv-001", "world"]);
    expect(tree[0]?.components).toContain("planner");
    expect(tree[2]?.components).toEqual(["sim", "storage"]);
    expect(filterFitsView(metricFilterFor("uav-001"), "series")).toBe(true);
    expect(filterFitsView(metricFilterFor("world"), "series")).toBe(true);
  });
});

describe("the layout the researcher keeps", () => {
  it("round-trips through user_data and leaves out a pane that is not valid", async () => {
    const { userData } = createMemoryPorts();
    expect(await loadInspectorLayout(userData)).toBeUndefined();
    await storeInspectorLayout(userData, DEFAULT_PANES);
    expect(await loadInspectorLayout(userData)).toEqual([...DEFAULT_PANES]);
    await userData.set("inspector", "layout", [
      { id: "a", view: "log", filter: "kind:action", title: "ok" },
      { id: "b", view: "series", filter: "kind:action", title: "wrong filter for its view" },
      { id: "c", view: "mind-io", filter: "", title: "a view that is not there" },
      { id: "a", view: "log", filter: "", title: "same id" },
      { id: "bad id!", view: "log", filter: "", title: "x" },
      "junk",
    ]);
    expect(await loadInspectorLayout(userData)).toEqual([{ id: "a", view: "log", filter: "kind:action", title: "ok" }]);
  });
});
