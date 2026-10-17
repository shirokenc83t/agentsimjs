import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, runCommand, sceneSettled, step, waitForStorageReady } from "./helpers.ts";

/** Screen point of a ground position (metres) in the visible scene (editor or Scene workspace). */
async function ground(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(([gx, gy]) => window.__agentsim?.scene?.screenOfGround(gx ?? 0, gy ?? 0), [x, y]);
  if (!p) throw new Error("no scene probe");
  return p;
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await ground(page, ...from);
  const b = await ground(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

async function click(page: Page, x: number, y: number) {
  const p = await ground(page, x, y);
  await page.mouse.click(p.x, p.y);
}

const cellOcc = (page: Page, i: number, j: number) => page.evaluate(([ci, cj]) => window.__agentsim?.scene?.cell(ci ?? 0, cj ?? 0)?.occupancy, [i, j]);
const settled = sceneSettled;

/** A new 64 × 64 scenario at 0.5 m (32 m square), open in the editor with the paint tool. */
async function newScenario(page: Page, id: string) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "author");
  await page.getByTestId("ed-new").click();
  await page.getByTestId("ed-new-id").fill(id);
  await page.getByTestId("ed-new-x").fill("64");
  await page.getByTestId("ed-new-y").fill("64");
  await page.getByTestId("ed-new-create").click();
  await expect(page.getByTestId("ed-status")).toHaveText("64 × 64 cells at 0.5 m · not saved · unsaved changes");
  await settled(page);
}

// ROADMAP F1 UI: scenario editor v0. The run simulates exactly the painted world (no hidden second copy).
test("paint a wall, draw a base, place an agent, save a version and run it: the run simulates the painted world", async ({ page }) => {
  test.setTimeout(90_000);
  await newScenario(page, "e7-yard");

  // A wall at x = 16 m from y = 4 m to y = 28 m (radius 1 → 3 cells wide).
  await drag(page, [16.25, 4], [16.25, 28]);
  await expect.poll(() => cellOcc(page, 32, 40)).toBe(1);
  expect(await cellOcc(page, 32, 2)).toBe(0);

  // A stroke is one undo step.
  await drag(page, [4, 24], [10, 24]);
  await expect.poll(() => cellOcc(page, 14, 48)).toBe(1);
  await page.getByTestId("ed-undo").click();
  await expect.poll(() => cellOcc(page, 14, 48)).toBe(0);
  expect(await cellOcc(page, 32, 40)).toBe(1);

  await page.getByTestId("ed-tool-zone").click();
  await page.getByTestId("ed-zone-kind").selectOption("base");
  await drag(page, [1, 1], [5, 5]);
  await expect(page.getByTestId("ed-zone-base-1")).toBeVisible();

  await page.getByTestId("ed-tool-agent").click();
  await click(page, 8, 16);
  await expect(page.getByTestId("ed-agent-form")).toContainText("ugv-001");
  await expect(page.getByTestId("ed-agent-key")).toHaveValue("ugv-1");
  await expect(page.getByTestId("ed-agent-base-x")).toHaveValue("3");
  await page.getByTestId("ed-body-maxSpeedMps").fill("1.5");

  await page.getByTestId("ed-save").click();
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ saved e7-yard v1");
  await expect(page.getByTestId("ed-status")).toHaveText("64 × 64 cells at 0.5 m · v1");

  await page.getByTestId("ed-run-button").click();
  await expect(page.getByTestId("workspace-scene")).toBeVisible();
  await expect(page.getByTestId("run-label")).toContainText("e7-yard v1");
  await settled(page);

  // The Scene's cell inspector sees the painted wall; the agent carries the authored body.
  await click(page, 16.2, 20.2);
  await expect(page.getByTestId("inspector-cell")).toContainText("blocked");
  await page.getByTestId("explorer-row-ugv-001").click();
  await expect(page.getByTestId("inspector-config")).toContainText("1.5");

  // Planning sees it too: the path to the other side goes around the wall's end.
  await page.getByTestId("send-to").click();
  await click(page, 24, 16);
  await step(page, 1);
  const text = (await page.getByTestId("inspector-plan-waypoints").textContent()) ?? "";
  const ys = [...text.matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g)].map((m) => Number(m[2]));
  expect(ys.some((y) => y < 4 || y > 28), text).toBe(true);

  // A scenario with stored runs cannot be deleted (its runs must stay replayable).
  await openWorkspace(page, "author");
  await page.getByTestId("ed-open-select").selectOption("e7-yard");
  await page.getByTestId("ed-open").click();
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ opened e7-yard v1");
  await page.getByTestId("ed-delete").click();
  await page.getByTestId("ed-delete-confirm").click();
  await expect(page.getByTestId("ed-error")).toContainText("scenario_in_use");
});

test("export and import JSON: the exported file is the saved document; invalid files are rejected with a code", async ({ page }) => {
  await newScenario(page, "e7-io");
  await page.getByTestId("ed-tool-agent").click();
  await click(page, 10, 10);
  await page.getByTestId("ed-save").click();
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ saved e7-io v1");

  const download = page.waitForEvent("download");
  await page.getByTestId("ed-export").click();
  const file = await (await download).path();
  const doc = JSON.parse(readFileSync(file, "utf8")) as { id: string; name: string; agents: unknown[]; world: { sizeCells: unknown } };
  expect(doc).toMatchObject({ id: "e7-io", agents: [{ kind: "ugv", key: "ugv-1", start: { xM: 10, yM: 10 } }], world: { sizeCells: { x: 64, y: 64 } } });

  const upload = (name: string, body: unknown) =>
    page.getByTestId("ed-import-file").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

  await upload("broken.json", "{ not json");
  await expect(page.getByTestId("ed-error")).toContainText("invalid_json");
  await upload("extra.json", { ...doc, script: "alert(1)" });
  await expect(page.getByTestId("ed-error")).toContainText("invalid_document");
  await upload("bad-rle.json", { ...doc, world: { ...doc.world, layers: { occupancy: { chunks: [{ ci: 0, cj: 0, rle: "AAAAAAAA" }] } } } });
  await expect(page.getByTestId("ed-error")).toContainText(/layer_decode_failed|invalid_document/);

  await upload("renamed.json", { ...doc, name: "Renamed by file" });
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ imported renamed.json (not saved yet)");
  await expect(page.getByTestId("ed-meta-name")).toHaveValue("Renamed by file");
  await page.getByTestId("ed-save").click();
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ saved e7-io v2");

  // No stored runs: every version can be deleted (tombstones keep the numbers).
  await page.getByTestId("ed-delete").click();
  await page.getByTestId("ed-delete-confirm").click();
  await expect(page.getByTestId("ed-msg")).toContainText("deleted every version of e7-io");
  await runCommand(page, "Switch to Data workspace");
});
