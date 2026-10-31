import { expect, test, type Page } from "@playwright/test";
import { openPanelTab, openWorkspace, waitForStorageReady } from "./helpers.ts";

// F4 M4 (T-124): the Library in Configurations: a profile and a template imported as JSON, versions that are never changed (an edit is a new version), the diff between two versions, and the template editor
// (CodeMirror) with its fixed slots and the marks of the validator. No server, no key.

const PROFILE = { schemaVersion: 1, kind: "mind-profile", shape: "s2", s2: { provider: "local-ollama", model: "llama3.1:8b", promptTemplate: { id: "default", version: 1 }, limits: { calls: 20 } } };
const TEMPLATE = { schemaVersion: 1, kind: "prompt-template", system: "You are a careful mind.", sections: ["role", "mission", "actions"], instructions: { mission: "Read this first." } };

async function importJson(page: Page, name: string, doc: unknown) {
  await page.getByTestId("lib-import-file").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.getByTestId("lib-message")).toContainText("imported as");
}

async function openLibrary(page: Page) {
  await page.goto("/?probe");
  await waitForStorageReady(page);
  await openWorkspace(page, "configurations");
  await openPanelTab(page, "Library");
  await expect(page.getByTestId("library-panel")).toBeVisible();
}

test("a profile: imported, edited as a new version, the old one unchanged, the diff between them", async ({ page }) => {
  await openLibrary(page);
  await importJson(page, "scout-llm.json", PROFILE);
  await expect(page.getByTestId("lib-item-scout-llm")).toContainText("s2 · local-ollama");
  await expect(page.getByTestId("lib-profile-table")).toContainText("llama3.1:8b");
  await expect(page.getByTestId("lib-used")).toContainText("v1 not used");
  await page.getByTestId("lib-edit").click();
  await expect(page.getByTestId("lib-edit")).toHaveCount(0);
  await page.getByTestId("lib-f-model").fill("qwen2.5:7b");
  await page.getByTestId("lib-f-calls").fill("30");
  await page.getByTestId("lib-save").click();
  await expect(page.getByTestId("lib-message")).toContainText("saved as scout-llm v2");
  await expect(page.getByTestId("lib-profile-table")).toContainText("qwen2.5:7b");
  // v1 is as it was.
  await page.getByTestId("lib-version-1").click();
  await expect(page.getByTestId("lib-profile-table")).toContainText("llama3.1:8b");
  await expect(page.getByTestId("lib-profile-table")).not.toContainText("qwen2.5:7b");
  // The diff of v2 against v1 says what changed.
  await page.getByTestId("lib-version-2").click();
  await page.getByTestId("lib-compare").check();
  const diff = page.getByTestId("lib-diff");
  await expect(diff.locator('tr[data-change="changed"]').filter({ hasText: "s2.model" })).toHaveCount(1);
  await expect(diff.locator('tr[data-change="changed"]').filter({ hasText: "s2.limits.calls" })).toHaveCount(1);
  // A duplicate is a new profile at v1.
  await page.getByTestId("lib-compare").uncheck();
  await page.getByTestId("lib-duplicate").click();
  await page.getByTestId("lib-dup-save").click();
  await expect(page.getByTestId("lib-item-scout-llm-copy")).toBeVisible();
});

test("a template: the editor keeps the slots fixed, marks what the validator refuses, and a save makes a new version while the old one stays", async ({ page }) => {
  await openLibrary(page);
  await importJson(page, "inspect.json", TEMPLATE);
  await page.getByTestId("lib-tab-template").click();
  await page.getByTestId("lib-item-inspect").click();
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("You are a careful mind.");
  await expect(page.locator('.cm-slot-chip[data-slot="role"]')).toBeVisible();
  await expect(page.getByTestId("lib-tokens")).toContainText("system 6 tok");
  // Read only until it is edited: typing changes nothing.
  await editor.click();
  await page.keyboard.type("zzz");
  await expect(editor).not.toContainText("zzz");
  await page.getByTestId("lib-edit").click();
  // Editable now: text at the start of the system block goes in; a character typed inside a slot line does not.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("Note: ");
  await expect(page.locator(".cm-content")).toContainText("Note: You are a careful mind.");
  const slot = page.locator('.cm-slot-chip[data-slot="role"]');
  await slot.click({ position: { x: 14, y: 4 } });
  await page.keyboard.type("x");
  await expect(page.locator('.cm-slot-chip[data-slot="role"]')).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("x‹role");
  await expect(page.locator(".cm-content")).not.toContainText("role›x");
  // An unknown slot added at the end is a fault: marked, listed, and the save is off.
  await page.getByTestId("lib-slot-notebook").click();
  await expect(page.locator('.cm-slot-chip[data-slot="notebook"]')).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("{{weather}}");
  await expect(page.getByTestId("lib-issues")).toContainText("template_slot_unknown");
  await expect(page.getByTestId("lib-save")).toBeDisabled();
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible({ timeout: 10_000 });
  // Take the fault away: the whole line goes (a slot is deleted whole or not at all), the save works and makes v2; v1 is as it was.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("lib-issues")).toHaveCount(0);
  await page.getByTestId("lib-save").click();
  await expect(page.getByTestId("lib-message")).toContainText("saved as inspect v2");
  await page.getByTestId("lib-version-1").click();
  await expect(page.locator(".cm-content")).not.toContainText("Note:");
  await expect(page.locator('.cm-slot-chip[data-slot="notebook"]')).toHaveCount(0);
  await page.getByTestId("lib-version-2").click();
  await expect(page.locator(".cm-content")).toContainText("Note: You are a careful mind.");
  await page.getByTestId("lib-compare").check();
  await expect(page.getByTestId("lib-diff").locator('tr[data-change="changed"]').filter({ hasText: "system" })).toHaveCount(1);
});

test("a template imported while a profile is on show opens in the editor (the versions on show are those of the item and the kind)", async ({ page }) => {
  await openLibrary(page);
  await importJson(page, "scout-llm.json", PROFILE);
  await expect(page.getByTestId("lib-profile-table")).toBeVisible();
  await importJson(page, "inspect.json", TEMPLATE);
  await expect(page.locator(".cm-content")).toContainText("You are a careful mind.");
  await page.getByTestId("lib-tab-profile").click();
  await page.getByTestId("lib-item-scout-llm").click();
  await expect(page.getByTestId("lib-profile-table")).toContainText("llama3.1:8b");
});

test("a known slot is a chip that is atomic and fixed: one arrow key selects it whole, a backspace takes it whole, and no edit goes inside it", async ({ page }) => {
  await openLibrary(page);
  await importJson(page, "inspect.json", TEMPLATE);
  await page.getByTestId("lib-tab-template").click();
  await page.getByTestId("lib-item-inspect").click();
  await page.getByTestId("lib-edit").click();
  await page.locator(".cm-content").click();
  // From the start of the second line (the role slot): shift + right arrow selects the chip as a whole (a caret that could enter it would select one brace).
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("role");
  // The caret at the end of the slot line, a backspace: the slot goes whole, nothing of it is left as text.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await expect(page.locator('.cm-slot-chip[data-slot="role"]')).toHaveCount(0);
  await expect(page.locator('.cm-slot-chip[data-slot="mission"]')).toBeVisible();
  const text = (await page.locator(".cm-content").textContent()) ?? "";
  expect(text).not.toMatch(/[{}]/);
  expect(text).not.toContain("role");
});
