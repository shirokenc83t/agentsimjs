import Type from "typebox";
import { describe, expect, it, vi } from "vitest";
import { initValidation } from "./init-validation.ts";
import { validate } from "./validation.ts";

describe("validation (ADR-0018)", () => {
  it("never constructs functions at runtime (no code generation)", () => {
    initValidation();
    const spy = vi.spyOn(globalThis, "Function");
    const T = Type.Object({ a: Type.Number(), b: Type.Array(Type.String()) });
    for (let i = 0; i < 50; i++) validate(T, { a: i, b: ["x"] });
    validate(T, { a: "nope" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns issues with JSON pointer paths", () => {
    const r = validate(Type.Object({ a: Type.Number() }), { a: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.path).toBe("/a");
  });
});
