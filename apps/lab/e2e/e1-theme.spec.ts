import { expect, test, type Page } from "@playwright/test";
import { BOOT_SETTINGS } from "../../../packages/ui/src/boot-settings.ts";
import { openWorkspace, waitForStorageReady } from "./helpers.ts";

const tick = async (page: Page) => Number((await page.getByTestId("status-tick").textContent())?.replace(/\D/g, "") ?? "0");

// ADR-0032 §2: dark by default (or the OS preference), light everywhere, switching never reloads or
// touches the simulation; the choice lives in user_data and is mirrored for first paint.
test("theme switches without reload, the sim keeps running, and the choice survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await waitForStorageReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await openWorkspace(page, "settings");
  const before = await tick(page);
  await page.getByTestId("theme-light").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(darkBg);
  // No reload: the sim kept ticking through the switch.
  await expect.poll(() => tick(page)).toBeGreaterThan(before);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);

  await page.reload();
  // First paint already light (mirror), then confirmed by user_data.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await waitForStorageReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // Only boot settings live in localStorage (ADR-0032 addition of 2026-10-04).
  const keys = await page.evaluate(() => Object.keys(localStorage));
  const allowed: string[] = Object.values(BOOT_SETTINGS).map((b) => b.key);
  expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
  expect(keys).toContain(BOOT_SETTINGS["ui.theme"].key);
});

test("system follows the OS preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
