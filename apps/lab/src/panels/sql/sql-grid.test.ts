import { describe, expect, it } from "vitest";
import { cellText, columnWidths } from "./sql-grid.ts";

describe("columnWidths", () => {
  it("sizes each column to its header and its values, not to the width of the panel", () => {
    const w = columnWidths({ columns: ["kind", "n"], rows: [["observation", 120], ["action", 7]] });
    expect(w[0]).toBe("observation".length + 1);
    expect(w[1]).toBeLessThanOrEqual(5);
  });

  it("keeps a header that is longer than its values, a floor for a tiny column and a ceiling for a long text", () => {
    const w = columnWidths({ columns: ["a_rather_long_header", "x", "t"], rows: [[1, 2, "y".repeat(500)]] });
    expect(w[0]).toBe("a_rather_long_header".length + 3);
    expect(w[1]).toBe(4);
    expect(w[2]).toBe(56);
  });

  it("reads nothing for a result without rows but its header, and shows NULL for null", () => {
    expect(columnWidths({ columns: ["n"], rows: [] })).toEqual([4]);
    expect(cellText(null)).toBe("NULL");
    expect(cellText(12)).toBe("12");
  });
});
