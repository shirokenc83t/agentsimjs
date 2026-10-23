import { createMemoryPorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { loadSnippets, MAX_SNIPPETS, storeSnippets, withoutSnippet, withSnippet } from "./sql-snippets.ts";

describe("snippets of the SQL console", () => {
  it("round-trip through user_data in the order they were saved; saving under an existing name replaces it; a delete removes one", async () => {
    const { userData } = createMemoryPorts();
    expect(await loadSnippets(userData)).toEqual([]);
    let list = withSnippet([], "runs", "SELECT * FROM runs");
    list = withSnippet(list, "metrics", "SELECT name, count(*) FROM metrics GROUP BY name");
    list = withSnippet(list, "runs", "SELECT run_id FROM runs");
    await storeSnippets(userData, list);
    expect(await loadSnippets(userData)).toEqual([{ name: "runs", sql: "SELECT run_id FROM runs" }, { name: "metrics", sql: "SELECT name, count(*) FROM metrics GROUP BY name" }]);
    expect(withoutSnippet(list, "runs").map((s) => s.name)).toEqual(["metrics"]);
  });

  it("keeps out an empty statement and a name that is not a name; reads what is stored defensively; holds a number", async () => {
    expect(withSnippet([], "x", "   ")).toEqual([]);
    expect(withSnippet([], "", "SELECT 1")).toEqual([]);
    expect(withSnippet([], "n".repeat(41), "SELECT 1")).toEqual([]);
    const { userData } = createMemoryPorts();
    await userData.set("sql", "snippets", [{ name: "ok", sql: "SELECT 1" }, { name: "empty", sql: " " }, { name: 5, sql: "SELECT 2" }, "junk", { name: "ok", sql: "SELECT 3" }]);
    expect(await loadSnippets(userData)).toEqual([{ name: "ok", sql: "SELECT 1" }]);
    let list: ReturnType<typeof withSnippet> = [];
    for (let i = 0; i < MAX_SNIPPETS + 5; i++) list = withSnippet(list, `s${i}`, "SELECT 1");
    expect(list).toHaveLength(MAX_SNIPPETS);
  });
});
