import { describe, expect, it } from "vitest";
import { compileExpr, evaluateCondition, evaluateExpr, EXPR_LIMITS, type ExprContext } from "./expr.ts";

const ctx: ExprContext = {
  altitude: { type: "number" },
  terrain: { type: "number" },
  turn: { type: "number" },
  armed: { type: "boolean" },
  vehicle: { type: "enum", values: ["uav", "ugv"] },
};

/** Compiles and evaluates with named values (test helper; production uses slot arrays). */
function run(src: string, values: Record<string, number>): boolean {
  const c = compileExpr(src, ctx);
  if (!c.ok) throw new Error(`${c.error.code}: ${c.error.message}`);
  return evaluateCondition(c.value, c.value.variables.map((v) => values[v] ?? Number.NaN));
}

describe("expression grammar v1 (ADR-0026)", () => {
  it("evaluates comparisons, arithmetic, boolean logic and enums with correct precedence", () => {
    expect(run("altitude <= 60", { altitude: 50 })).toBe(true);
    expect(run("altitude - terrain * 2 <= 30", { altitude: 40, terrain: 5 })).toBe(true); // 40 - 10
    expect(run("(altitude - terrain) * 2 <= 30", { altitude: 40, terrain: 5 })).toBe(false); // 70
    expect(run("not armed or altitude > 10", { armed: 1, altitude: 5 })).toBe(false);
    expect(run("vehicle == \"ugv\" and terrain < 3", { vehicle: 1, terrain: 2 })).toBe(true);
    expect(run("\"uav\" != vehicle", { vehicle: 0 })).toBe(false);
    expect(run("-altitude < -5", { altitude: 10 })).toBe(true);
    expect(run("true and not false", {})).toBe(true);
    expect(run("1.5e2 == 150", {})).toBe(true);
  });

  it("lists referenced variables in sorted slot order", () => {
    const c = compileExpr("turn < 1 and altitude > terrain", ctx);
    expect(c.ok && c.value.variables).toEqual(["altitude", "terrain", "turn"]);
  });

  it("fails closed on non-finite intermediates", () => {
    expect(run("altitude / terrain < 100", { altitude: 1, terrain: 0 })).toBe(false); // 1/0
    expect(run("not (altitude / terrain < 100)", { altitude: 1, terrain: 0 })).toBe(false); // still closed
    expect(run("altitude * 1e12 * 1e12 * 1e12 < 1", { altitude: 1e300 })).toBe(false);
    const c = compileExpr("altitude / terrain", ctx, "number");
    expect(c.ok && Number.isNaN(evaluateExpr(c.value, [1, 0]))).toBe(true);
  });

  it.each([
    ["altitude + armed > 1", "expr_type"],
    ["altitude and armed", "expr_type"],
    ["vehicle < 3", "expr_type"],
    ["vehicle == 1", "expr_type"],
    ["vehicle == \"boat\"", "expr_unknown_enum_value"],
    ["altitude == \"uav\"", "expr_type"],
    ["altitude + 1", "expr_type"], // not a boolean
    ["\"uav\"", "expr_type"],
    ["speed > 1", "expr_unknown_name"],
    ["altitude >", "expr_syntax"],
    ["(altitude > 1", "expr_syntax"],
    ["altitude > 1 1", "expr_syntax"],
    ["1e13 > altitude", "expr_number_out_of_range"],
  ])("rejects %s with %s", (src, code) => {
    const r = compileExpr(src, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.position).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    ["constructor", "expr_unknown_name"],
    ["__proto__ == 1", "expr_unknown_name"],
    ["toString > 0", "expr_unknown_name"],
    ["this.altitude > 1", "expr_unknown_name"],
    ["altitude.constructor > 1", "expr_unknown_name"],
    ["altitude > 1; armed", "expr_bad_char"],
    ["`altitude` > 1", "expr_bad_char"],
    ["(x) => x", "expr_bad_char"],
    ["altitude > \"\\u0041\"", "expr_bad_char"],
    ["altitude > \"${process}\"", "expr_bad_char"],
    ["altitude[0] > 1", "expr_bad_char"],
    ["eval(\"1\")", "expr_unknown_name"],
    ["altitude = 5", "expr_bad_char"],
    ["altitude > 1 || armed", "expr_bad_char"],
    ["altitude ≥ 1", "expr_bad_char"],
  ])("rejects malicious input %s", (src, code) => {
    const r = compileExpr(src, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it("enforces the size, node and depth limits", () => {
    const long = "altitude > 1 and ".repeat(40) + "armed";
    expect(long.length).toBeGreaterThan(EXPR_LIMITS.maxSourceLength);
    expect(compileExpr(long, ctx).ok ? null : (compileExpr(long, ctx) as { error: { code: string } }).error.code).toBe("expr_too_long");

    const manyNodes = Array.from({ length: 20 }, () => "altitude > 1").join(" and ");
    const r1 = compileExpr(manyNodes, ctx);
    expect(r1.ok ? null : r1.error.code).toBe("expr_too_many_nodes");

    const deep = "(".repeat(20) + "altitude" + ")".repeat(20) + " > 1";
    expect(compileExpr(deep, ctx).ok).toBe(true); // parentheses alone do not add tree depth
    const deepTree = "-".repeat(20) + "altitude > 1";
    const r2 = compileExpr(deepTree, ctx);
    expect(r2.ok ? null : r2.error.code).toBe("expr_too_deep");

    const ident = "a".repeat(EXPR_LIMITS.maxIdentifierLength + 1) + " > 1";
    const r3 = compileExpr(ident, ctx);
    expect(r3.ok ? null : r3.error.code).toBe("expr_identifier_too_long");
  });
});
