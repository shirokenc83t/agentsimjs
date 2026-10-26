import { expect, test, type Page } from "@playwright/test";
import { loadF2, openScenarioEditor, sceneSettled } from "./helpers.ts";

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
const occupancy = (page: Page, i: number, j: number) => page.evaluate(([ci, cj]) => window.__agentsim?.scene?.cell(ci ?? 0, cj ?? 0)?.occupancy, [i, j]);
const priorCell = (page: Page, i: number, j: number) => page.evaluate(([ci, cj]) => window.__agentsim?.scene?.beliefCell(ci ?? 0, cj ?? 0), [i, j]);

/** Opens the stored F2 discovery scenario (stored by loading the preset) in the editor. */
async function openDiscovery(page: Page) {
  await loadF2(page, "discovery");
  await openScenarioEditor(page);
  await page.getByTestId("ed-open-select").selectOption("f2-discovery");
  await page.getByTestId("ed-open").click();
  await expect(page.getByTestId("ed-status")).toContainText("128 × 128 cells at 0.5 m · v1");
  await sceneSettled(page);
}

// ADR-0025 additions of 2026-10-09: objects and priors are part of a scenario, and the editor keeps and edits them.
test("objects: the stored scenario's object is kept, a new one is placed, and id problems show their codes inline", async ({ page }) => {
  test.setTimeout(120_000);
  await openDiscovery(page);
  await expect(page.getByTestId("ed-object-marker-1")).toBeVisible();
  await expect(page.getByTestId("ed-validation")).toContainText("valid");

  await page.getByTestId("ed-tool-object").click();
  await click(page, 20, 20);
  await expect(page.getByTestId("ed-object-marker-2")).toBeVisible();
  await expect(page.getByTestId("ed-object-form")).toBeVisible();

  // An id in the agent-ID form, then a duplicate: refused with the loader's codes, shown inline.
  await page.getByTestId("ed-object-id").fill("ugv-001");
  await expect(page.getByTestId("ed-validation-error")).toContainText("object_id_reserved");
  await page.getByTestId("ed-object-id").fill("marker-1");
  await expect(page.getByTestId("ed-validation-error")).toContainText("object_id_duplicate");
  await page.getByTestId("ed-object-id").fill("beacon");
  await expect(page.getByTestId("ed-validation")).toContainText("valid");

  // Saving creates a new version (never overwrites); reopening shows both objects.
  await page.getByTestId("ed-save").click();
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ saved f2-discovery v2");
  await page.getByTestId("ed-open").click();
  await expect(page.getByTestId("ed-object-beacon")).toBeVisible();
  await expect(page.getByTestId("ed-object-marker-1")).toBeVisible();
});

test("priors: made from the world, shown against it, edited without touching the world, and saved as a new version", async ({ page }) => {
  test.setTimeout(120_000);
  await openDiscovery(page);
  await page.getByTestId("ed-prior-new-id").fill("survey");
  await page.getByTestId("ed-prior-create").click();
  await expect(page.getByTestId("ed-prior-survey")).toContainText("knows 100.0 %");
  await expect(page.getByTestId("ed-prior-survey")).toContainText("0.0 % of that differs");

  // Show it against the world, then edit it: the paint tool says which one it paints.
  await page.getByTestId("ed-prior-edit-survey").click();
  await expect(page.getByTestId("ed-edit-target")).toContainText("Painting PRIOR “survey” — the world is not changed");
  await page.getByTestId("ed-prior-mode-difference").click();
  await expect(page.getByTestId("ed-researcher-marker")).toContainText("Researcher view — not visible to the mind");
  // The F1 wall (x = 30 m, cells 60–61) is a wall in the world; hide it from the prior with the prior brush.
  expect(await occupancy(page, 60, 40)).toBe(1);
  await expect.poll(() => priorCell(page, 60, 40)).toBe(2);
  await page.getByTestId("ed-prior-brush-radius").fill("2");
  await drag(page, [30.25, 14], [30.25, 26]);
  await expect.poll(() => priorCell(page, 60, 40)).toBe(0); // the prior no longer knows it
  expect(await occupancy(page, 60, 40), "the world is unchanged").toBe(1);
  await expect(page.getByTestId("ed-prior-survey")).toContainText("edited");
  await expect(page.getByTestId("ed-prior-survey")).not.toContainText("knows 100.0 %");

  // A flip makes the prior wrong about the world: its disagreement shows up in the list.
  await page.getByTestId("ed-prior-brush-value").selectOption("flip");
  await drag(page, [10, 40], [14, 40]);
  await expect(page.getByTestId("ed-prior-survey")).not.toContainText("0.0 % of that differs");

  // Back to the world: the banner says so.
  await page.getByTestId("ed-prior-edit-survey").click();
  await expect(page.getByTestId("ed-edit-target")).toContainText("Painting the WORLD");

  // Saved as a new version; reopened, the prior is still edited and the world is as it was.
  await page.getByTestId("ed-save").click();
  await expect(page.getByTestId("ed-msg")).toHaveText("✓ saved f2-discovery v2");
  await page.getByTestId("ed-open").click();
  await expect(page.getByTestId("ed-prior-survey")).toContainText("knows");
  await expect(page.getByTestId("ed-prior-survey")).not.toContainText("knows 100.0 %");
  await sceneSettled(page);
  // `occupancy` reads the atlas's CPU copy (raw cell bytes, not rendered pixels), where 255 means "chunk not uploaded yet".
  // Reopening replaces the atlas and uploads its chunks in the next frame, and the checks above also hold for the draft
  // still shown, so the first read can fall in that frame: poll until the reloaded world is there.
  await expect.poll(() => occupancy(page, 60, 40), { message: "the saved world is as it was" }).toBe(1);
});
