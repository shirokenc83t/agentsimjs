import { expect, test } from "@playwright/test";
import { openWorkspace, waitForStorageReady, watchCsp } from "./helpers.ts";

// ADR-0018 / ADR-0021: strict CSP — no 'unsafe-eval', 'wasm-unsafe-eval' allowed for sqlite-wasm.
test("serves the strict CSP, enforces it, and the app runs without violations", async ({ page }) => {
  const problems = watchCsp(page);
  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toMatch(/'unsafe-eval'/);
  expect(csp).not.toMatch(/'unsafe-inline'[^;]*script|script-src[^;]*'unsafe-inline'/);

  await waitForStorageReady(page);
  for (const ws of ["data", "settings", "scene"] as const) await openWorkspace(page, ws);
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);

  // The policy is enforced in the page realm. (DevTools evaluation itself is exempt from CSP, so the
  // probe schedules a string timer that compiles later, in the page's own context.)
  const probe = await page.evaluate(
    () =>
      new Promise<{ ran: boolean; violation: string | null }>((resolve) => {
        const w = window as unknown as { __cspProbeRan?: boolean };
        w.__cspProbeRan = false;
        let violation: string | null = null;
        document.addEventListener("securitypolicyviolation", (e) => (violation = `${e.violatedDirective} ${e.blockedURI}`), { once: true });
        // eslint-disable-next-line no-implied-eval -- deliberately probing that the CSP refuses code generation
        setTimeout("window.__cspProbeRan = true", 0);
        setTimeout(() => resolve({ ran: w.__cspProbeRan === true, violation }), 200);
      }),
  );
  expect(probe.ran).toBe(false);
  expect(probe.violation).toMatch(/^script-src(-elem)? eval$/);
});

test("shell: workspaces, command palette and status line", async ({ page }) => {
  await page.goto("/");
  await waitForStorageReady(page);
  await expect(page.getByTestId("statusline")).toContainText("tick");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("storage browser");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("storage-browser")).toBeVisible();
  await openWorkspace(page, "settings");
  await expect(page.getByTestId("settings-panel")).toContainText("Minimum quota");
});
