import { createMemoryPorts } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { deleteNamedLayout, layoutName, listNamedLayouts, MAX_LAYOUT_NAME, readNamedLayout, saveNamedLayout } from "./layouts.ts";
import { LAYOUT_NAMESPACE, layoutKey } from "./presets.ts";

// A StorageClient reduced to the user-data port, over the in-memory ports.
const client = () => ({ ports: createMemoryPorts() }) as unknown as Parameters<typeof listNamedLayouts>[0];

describe("named layouts", () => {
  it("a name is trimmed and its spaces collapsed; empty or too long is no name", () => {
    expect(layoutName("  my   layout ")).toBe("my layout");
    expect(layoutName("   ")).toBeUndefined();
    expect(layoutName("x".repeat(MAX_LAYOUT_NAME))).toBeDefined();
    expect(layoutName("x".repeat(MAX_LAYOUT_NAME + 1))).toBeUndefined();
  });

  it("are saved per workspace, listed by name, read back, replaced under the same name and deleted; the autosaved layout is not one of them", async () => {
    const storage = client();
    await storage.ports.userData.set(LAYOUT_NAMESPACE, layoutKey("scene"), { autosaved: true });
    await saveNamedLayout(storage, "scene", "wide map", { v: 1 });
    await saveNamedLayout(storage, "scene", "a debugging one", { v: 2 });
    await saveNamedLayout(storage, "debug", "other workspace", { v: 3 });
    expect(await listNamedLayouts(storage, "scene")).toEqual(["a debugging one", "wide map"]);
    expect(await listNamedLayouts(storage, "debug")).toEqual(["other workspace"]);
    expect(await readNamedLayout(storage, "scene", "wide map")).toEqual({ v: 1 });
    await saveNamedLayout(storage, "scene", "wide map", { v: 9 });
    expect(await readNamedLayout(storage, "scene", "wide map")).toEqual({ v: 9 });
    await deleteNamedLayout(storage, "scene", "wide map");
    expect(await listNamedLayouts(storage, "scene")).toEqual(["a debugging one"]);
    expect(await storage.ports.userData.get(LAYOUT_NAMESPACE, layoutKey("scene"))).toEqual({ autosaved: true });
  });
});
