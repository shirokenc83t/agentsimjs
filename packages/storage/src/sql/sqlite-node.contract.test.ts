import { openNodeSqlDriver } from "../drivers/node-sql-driver.ts";
import { describeStorageContract } from "../testing/contract.ts";
import { migrate } from "./migrations.ts";
import { createSqlPorts } from "./sql-storage.ts";

// Same DDL and SQL as the browser storage worker (ADR-0010), over node:sqlite.
describeStorageContract("sqlite (node:sqlite)", async () => {
  const db = openNodeSqlDriver(":memory:");
  migrate(db, () => 0);
  return { ports: createSqlPorts(db, () => 0), dispose: async () => db.close() };
});
