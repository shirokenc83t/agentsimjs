import { describe, expect, it } from "vitest";
import { highlightSql } from "./sql-highlight.ts";

const kinds = (sql: string) => highlightSql(sql).filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`);

describe("highlightSql", () => {
  it("colours keywords, functions, numbers, strings and comments, and leaves names and punctuation plain", () => {
    expect(kinds("SELECT kind, count(*) AS n FROM trace_records WHERE seq > 10 AND source = 'ugv-001/body' -- why")).toEqual([
      "keyword:SELECT",
      "function:count",
      "keyword:AS",
      "keyword:FROM",
      "keyword:WHERE",
      "number:10",
      "keyword:AND",
      "string:'ugv-001/body'",
      "comment:-- why",
    ]);
  });

  it("gives the statement back character for character, whatever it holds", () => {
    for (const sql of ["", "SELECT 1", "select 'it''s' /* a\nb */ , 0x1F, 1.5e3, .5 from t -- end", "SELECT 'open string", "/* open", "a\tb\n\nc", "WITH RECURSIVE x(n) AS (SELECT 1) SELECT * FROM x"]) {
      expect(highlightSql(sql).map((t) => t.text).join("")).toBe(sql);
    }
  });

  it("reads a doubled quote as part of the string, a block comment across lines, and an unclosed string to the end", () => {
    expect(kinds("SELECT 'it''s'")).toEqual(["keyword:SELECT", "string:'it''s'"]);
    expect(kinds("SELECT /* a\nb */ 1")).toEqual(["keyword:SELECT", "comment:/* a\nb */", "number:1"]);
    expect(kinds("SELECT 'open")).toEqual(["keyword:SELECT", "string:'open"]);
  });

  it("does not take part of a name for a keyword or a number", () => {
    expect(kinds("SELECT selected, t1, from_x FROM t")).toEqual(["keyword:SELECT", "keyword:FROM"]);
  });
});
