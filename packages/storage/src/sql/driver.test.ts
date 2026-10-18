import { describe, expect, it } from "vitest";
import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";

// F3a M2: a transaction may span awaits (the storage worker commits what a recorder handed over, in order, in one transaction: ADR-0020
// addition of 2026-10-18); the shared transaction runner takes a function that returns a promise as well as one that returns a value.

function db() {
  const d = openNodeSqlDriver();
  d.exec("CREATE TABLE t (n INTEGER PRIMARY KEY)");
  return d;
}
const count = (d: ReturnType<typeof db>) => d.get<{ n: number }>("SELECT count(*) AS n FROM t")?.n;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SqlDriver.transaction", () => {
  it("commits what a synchronous function wrote, and rolls back when it throws", () => {
    const d = db();
    d.transaction(() => d.run("INSERT INTO t VALUES (1)"));
    expect(() => d.transaction(() => (d.run("INSERT INTO t VALUES (2)"), (() => { throw new Error("no"); })()))).toThrow("no");
    expect(count(d)).toBe(1);
  });

  it("commits what an asynchronous function wrote across its awaits, as one transaction", async () => {
    const d = db();
    const r = await d.transaction(async () => {
      d.run("INSERT INTO t VALUES (1)");
      await tick();
      d.run("INSERT INTO t VALUES (2)");
      await tick();
      return "done";
    });
    expect(r).toBe("done");
    expect(count(d)).toBe(2);
  });

  it("rolls everything back when an asynchronous function rejects after writing", async () => {
    const d = db();
    await expect(
      d.transaction(async () => {
        d.run("INSERT INTO t VALUES (1)");
        await tick();
        throw new Error("late");
      }),
    ).rejects.toThrow("late");
    expect(count(d)).toBe(0);
    // And the connection is usable afterwards (no transaction left open).
    d.transaction(() => d.run("INSERT INTO t VALUES (3)"));
    expect(count(d)).toBe(1);
  });

  it("nests a transaction inside an asynchronous one as a savepoint: a failed inner one leaves the outer one's writes", async () => {
    const d = db();
    await d.transaction(async () => {
      d.run("INSERT INTO t VALUES (1)");
      await tick();
      expect(() => d.transaction(() => (d.run("INSERT INTO t VALUES (2)"), (() => { throw new Error("inner"); })()))).toThrow("inner");
      await d.transaction(async () => {
        d.run("INSERT INTO t VALUES (4)");
        await tick();
      });
    });
    expect(d.all<{ n: number }>("SELECT n FROM t ORDER BY n").map((x) => x.n)).toEqual([1, 4]);
  });
});
