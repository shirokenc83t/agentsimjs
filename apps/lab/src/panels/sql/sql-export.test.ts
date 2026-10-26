import { describe, expect, it } from "vitest";
import { toCsv, toJsonl } from "./sql-export.ts";

const r = { columns: ["run_id", "label", "n"], rows: [["run-000001", "plain", 1], ["run-000002", 'say "hi", twice', 2.5], ["run-000003", "two\nlines", null]] as (string | number | null)[][] };

describe("export of a result", () => {
  it("is CSV with the header, quoting what needs it, and null as an empty cell", () => {
    expect(toCsv(r)).toBe('run_id,label,n\r\nrun-000001,plain,1\r\nrun-000002,"say ""hi"", twice",2.5\r\nrun-000003,"two\nlines",\r\n');
    expect(toCsv({ columns: ["a"], rows: [] })).toBe("a\r\n");
  });

  it("is JSON lines, an object a row", () => {
    const lines = toJsonl(r).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toEqual([{ run_id: "run-000001", label: "plain", n: 1 }, { run_id: "run-000002", label: 'say "hi", twice', n: 2.5 }, { run_id: "run-000003", label: "two\nlines", n: null }]);
    expect(toJsonl({ columns: ["a"], rows: [] })).toBe("");
  });
});
