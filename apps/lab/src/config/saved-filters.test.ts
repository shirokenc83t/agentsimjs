import { createMemoryPorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { loadSavedFilters, MAX_SAVED_FILTERS, storeSavedFilters, withoutSavedFilter, withSavedFilter } from "./saved-filters.ts";

describe("saved filters of the log console", () => {
  it("round-trips through user_data, in the order they were saved", async () => {
    const { userData } = createMemoryPorts();
    expect(await loadSavedFilters(userData)).toEqual([]);
    let list = withSavedFilter([], "failures", "kind:action text:failed");
    list = withSavedFilter(list, "rover", "agent:ugv-001 -kind:snapshot");
    await storeSavedFilters(userData, list);
    expect(await loadSavedFilters(userData)).toEqual([
      { name: "failures", text: "kind:action text:failed" },
      { name: "rover", text: "agent:ugv-001 -kind:snapshot" },
    ]);
  });

  it("saving under a name that exists replaces that filter, and a delete removes one", () => {
    const a = withSavedFilter([], "x", "kind:event");
    const b = withSavedFilter(a, "x", "kind:action");
    expect(b).toEqual([{ name: "x", text: "kind:action" }]);
    expect(withoutSavedFilter(withSavedFilter(b, "y", "agent:uav-001"), "x")).toEqual([{ name: "y", text: "agent:uav-001" }]);
  });

  it("keeps out a filter that does not parse and a name that is not a name; reads what is stored defensively", async () => {
    expect(withSavedFilter([], "bad", "kind:nonsense")).toEqual([]);
    expect(withSavedFilter([], "   ", "kind:event")).toEqual([]);
    expect(withSavedFilter([], "x".repeat(41), "kind:event")).toEqual([]);
    const { userData } = createMemoryPorts();
    await userData.set("log", "savedFilters", [{ name: "ok", text: "kind:event" }, { name: "bad", text: "nope" }, { name: 3, text: "kind:event" }, "junk", { name: "ok", text: "kind:action" }]);
    expect(await loadSavedFilters(userData)).toEqual([{ name: "ok", text: "kind:event" }]);
    await userData.set("log", "savedFilters", "not a list");
    expect(await loadSavedFilters(userData)).toEqual([]);
  });

  it("holds at most a number of filters", () => {
    let list: ReturnType<typeof withSavedFilter> = [];
    for (let i = 0; i < MAX_SAVED_FILTERS + 5; i++) list = withSavedFilter(list, `f${i}`, "kind:event");
    expect(list).toHaveLength(MAX_SAVED_FILTERS);
  });
});
