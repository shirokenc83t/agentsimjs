import { expect, it } from "vitest";
import { capabilityManifest } from "./manifest.ts";

it("the generated manifest is deterministic plain JSON", () => {
  const a = capabilityManifest();
  expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  expect(JSON.stringify(capabilityManifest())).toBe(JSON.stringify(a));
});

it("every capability exposes its params and result as JSON Schema with preconditions described", () => {
  for (const c of capabilityManifest().capabilities) {
    expect(c.params["type"]).toBe("object");
    expect(c.result["type"]).toBe("object");
    for (const p of c.preconditions) expect(p.description.length).toBeGreaterThan(0);
  }
});

// Generator snapshot (ADR-0007): any change to a capability shows up here and must be reviewed, since
// every exposure (provider tools, MQTT, MCP) is generated from this manifest.
it("matches the reviewed manifest snapshot", async () => {
  await expect(JSON.stringify(capabilityManifest(), null, 2) + "\n").toMatchFileSnapshot("./__snapshots__/manifest.json");
});
