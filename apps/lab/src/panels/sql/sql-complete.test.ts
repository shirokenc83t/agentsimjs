import type { SqlSchema } from "@agentsim/storage";
import { describe, expect, it } from "vitest";
import { complete, tablesOf } from "./sql-complete.ts";

const schema: SqlSchema = {
  tables: [
    { name: "trace_records", readable: true, columns: [{ name: "run_id", type: "TEXT" }, { name: "seq", type: "INTEGER" }, { name: "sim_time", type: "REAL" }, { name: "kind", type: "TEXT" }, { name: "payload", type: "TEXT" }] },
    { name: "metrics", readable: true, columns: [{ name: "run_id", type: "TEXT" }, { name: "name", type: "TEXT" }, { name: "value", type: "REAL" }] },
    { name: "runs", readable: true, columns: [{ name: "run_id", type: "TEXT" }, { name: "label", type: "TEXT" }] },
    { name: "user_data", readable: false, columns: [] },
  ],
  payloadKeys: ["op", "name", "queryId", "status"],
};
const at = (sql: string) => complete(sql.replace("|", ""), sql.indexOf("|"), schema);

describe("tablesOf", () => {
  const known = new Set(["trace_records", "metrics", "runs"]);
  it("finds the tables after FROM and JOIN, with their aliases", () => {
    expect(tablesOf("SELECT * FROM trace_records t JOIN runs AS r ON r.run_id = t.run_id WHERE x", known)).toEqual([{ table: "trace_records", alias: "t" }, { table: "runs", alias: "r" }]);
    expect(tablesOf("select 1 from metrics where name = 'x'", known)).toEqual([{ table: "metrics", alias: undefined }]);
    expect(tablesOf("select 1 from nonesuch", known)).toEqual([]);
  });
});

describe("complete", () => {
  it("offers tables, then keywords, for a word that begins one", () => {
    expect(at("SELECT * FROM tra|").items).toEqual(["trace_records"]);
    expect(at("SELECT * FROM m|").items).toEqual(expect.arrayContaining(["metrics", "MIN(", "MAX("]));
    expect(at("sel|").items).toEqual(["SELECT"]);
    expect(at("SELECT * FROM tra|").from).toBe(14);
  });

  it("offers the columns of the tables the statement uses before anything else", () => {
    const r = at("SELECT se| FROM trace_records");
    expect(r.items[0]).toBe("seq");
    expect(at("SELECT * FROM trace_records WHERE ki|").items[0]).toBe("kind");
    // not the columns of a table it does not use
    expect(at("SELECT la| FROM trace_records").items).not.toContain("label");
  });

  it("offers the columns after table. and alias., and replaces only what follows the dot", () => {
    expect(at("SELECT trace_records.se| FROM trace_records").items).toEqual(["seq"]);
    const a = at("SELECT t.| FROM trace_records t");
    expect(a.items).toEqual(["run_id", "seq", "sim_time", "kind", "payload"]);
    expect(a.from).toBe("SELECT t.".length);
    expect(at("SELECT r.la| FROM trace_records t JOIN runs r ON 1").items).toEqual(["label"]);
    expect(at("SELECT nothing.| FROM runs").items).toEqual([]);
  });

  it("offers the keys of the payloads inside a JSON path, from the dollar sign on", () => {
    const r = at("SELECT json_extract(payload, '$.|') FROM trace_records");
    expect(r.items).toEqual(["$.op", "$.name", "$.queryId", "$.status"]);
    expect(r.from).toBe("SELECT json_extract(payload, '".length);
    expect(at("SELECT json_extract(payload, '$.qu|') FROM trace_records").items).toEqual(["$.queryId"]);
  });

  it("offers nothing inside an ordinary string, after nothing typed, or for a table that is not readable", () => {
    expect(at("SELECT * FROM runs WHERE label = 'tra|'").items).toEqual([]);
    expect(at("SELECT * FROM runs |").items).toEqual([]);
    expect(at("SELECT * FROM user|").items).toEqual([]);
    expect(at("SELECT user_data.| FROM runs").items).toEqual([]);
  });

  it("is capped, and does not offer a word that is already complete and alone", () => {
    expect(at("S|").items.length).toBeLessThanOrEqual(12);
    expect(at("SELECT * FROM runs|").items).toEqual([]);
  });
});
