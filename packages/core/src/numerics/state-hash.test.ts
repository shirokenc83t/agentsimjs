import { describe, expect, it, vi } from "vitest";
import { StateHasher } from "./state-hash.ts";

describe("StateHasher (ADR-0023)", () => {
  it("canonicalizes NaN payloads and reports the field", () => {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, 0x7ff80000, true);
    view.setUint32(0, 0xdeadbeef, true); // NaN with a non-canonical payload
    const oddNaN = view.getFloat64(0, true);
    expect(Number.isNaN(oddNaN)).toBe(true);
    const reports = vi.fn();
    const a = new StateHasher(reports).u32(1).f64(Number.NaN, "agent.x").hex();
    const b = new StateHasher(reports).u32(1).f64(oddNaN, "agent.x").hex();
    expect(a).toBe(b);
    expect(reports).toHaveBeenCalledWith("agent.x");
  });

  it("is order- and value-sensitive", () => {
    const base = new StateHasher().u32(1).f64(2.5).str("uav-001").hex();
    expect(new StateHasher().u32(1).f64(2.5).str("uav-001").hex()).toBe(base);
    expect(new StateHasher().f64(2.5).u32(1).str("uav-001").hex()).not.toBe(base);
    expect(new StateHasher().u32(1).f64(2.5000000000000004).str("uav-001").hex()).not.toBe(base);
  });

  it("grows its buffer for large states", () => {
    const h = new StateHasher();
    for (let i = 0; i < 10_000; i++) h.f64(i);
    expect(h.hex()).toMatch(/^[0-9a-f]{8}$/);
  });
});
