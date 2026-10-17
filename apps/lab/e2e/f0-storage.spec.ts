import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { openWorkspace, waitForStorageReady, watchCsp } from "./helpers.ts";

function python(): string {
  const candidates = process.env["PYTHON"] ? [process.env["PYTHON"]] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      // try next
    }
  }
  throw new Error("Python 3 not found (set PYTHON)");
}

// F0 acceptance: data survives a page reload; the exported `.sqlite` opens in Python sqlite3.
// Also proves storage works under the strict CSP (ADR-0021).
test("data survives reload and the exported .sqlite opens in Python", async ({ page }, testInfo) => {
  const csp = watchCsp(page);
  await page.goto("/");
  await waitForStorageReady(page);
  await expect(page.getByTestId("status-storage")).toHaveText("db: opfs-sahpool");
  await openWorkspace(page, "data");

  await page.getByTestId("create-sample-run").click();
  await expect(page.getByTestId("storage-message")).toContainText("created run-");
  const runId = (await page.getByTestId("storage-message").textContent())?.match(/run-\d{6}/)?.[0] ?? "";
  await expect(page.getByTestId(`run-row-${runId}`)).toContainText("100");

  await page.reload();
  await waitForStorageReady(page);
  await openWorkspace(page, "data");
  await expect(page.getByTestId(`run-row-${runId}`)).toContainText("100");

  const download = page.waitForEvent("download");
  await page.getByTestId("export-db").click();
  const file = testInfo.outputPath("agentsim.sqlite");
  await (await download).saveAs(file);

  const out = execFileSync(python(), ["tools/scripts/check_sqlite_export.py", file, runId], { encoding: "utf8" });
  const summary = JSON.parse(out) as { integrity: string; runs: Record<string, number> };
  expect(summary.integrity).toBe("ok");
  expect(summary.runs[runId]).toBe(100);
  expect(csp).toEqual([]);
});

test("importing a .sqlite replaces the database; invalid files are rejected with a code", async ({ page }, testInfo) => {
  await page.goto("/");
  await waitForStorageReady(page);
  await openWorkspace(page, "data");
  await page.getByTestId("create-sample-run").click();
  await expect(page.getByTestId("storage-message")).toContainText("created run-");

  const download = page.waitForEvent("download");
  await page.getByTestId("export-db").click();
  const file = testInfo.outputPath("snapshot.sqlite");
  await (await download).saveAs(file);
  const before = await page.locator("[data-testid^=run-row-]").count();

  await page.getByTestId("create-sample-run").click();
  await expect(page.locator("[data-testid^=run-row-]")).toHaveCount(before + 1);

  await page.getByTestId("import-file").setInputFiles(file);
  await expect(page.getByTestId("storage-message")).toContainText("imported snapshot.sqlite");
  await expect(page.locator("[data-testid^=run-row-]")).toHaveCount(before);

  await page.getByTestId("import-file").setInputFiles({ name: "bad.sqlite", mimeType: "application/octet-stream", buffer: Buffer.from("nope".repeat(64)) });
  await expect(page.getByTestId("storage-message")).toContainText("import rejected (not_sqlite)");
});

// ADR-0020: OPFS unavailable (e.g. Safari private mode) → in-memory with a persistent warning.
test("falls back to in-memory storage with a persistent warning when OPFS is unavailable", async ({ page }) => {
  await page.goto("/?simulate-no-opfs");
  await expect(page.getByTestId("not-persistent")).toContainText("Storage is not persistent — export before closing");
  await expect(page.getByTestId("status-storage")).toHaveText("db: memory-fallback");
  await openWorkspace(page, "data");
  await expect(page.getByTestId("storage-mode")).toHaveText("memory-fallback");
  await page.getByTestId("create-sample-run").click();
  await expect(page.getByTestId("storage-message")).toContainText("created run-");
  await openWorkspace(page, "scene");
  await expect(page.getByTestId("not-persistent")).toBeVisible(); // persistent across workspaces
});
