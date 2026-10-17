import { expect, test } from "@playwright/test";
import { waitForStorageReady } from "./helpers.ts";

// Dockview is loaded after first paint (issue #4). The shell grid reserves the workspace row, so the
// toolbar and status line must not move when the workspace chunk arrives.
test("toolbar and status line do not shift when the deferred workspace arrives", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/workspace-host-[^/]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/?probe");
  await waitForStorageReady(page);
  const toolbar = page.getByRole("toolbar", { name: "Run control" });
  const status = page.getByTestId("statusline");
  await expect(page.getByTestId("workspace-scene")).toHaveCount(0);
  const before = { toolbar: await toolbar.boundingBox(), status: await status.boundingBox() };

  release();
  await expect(page.getByTestId("workspace-scene")).toBeVisible();
  await page.waitForFunction(() => window.__agentsim?.loadMarks["workspaceVisible"] !== undefined);
  const after = { toolbar: await toolbar.boundingBox(), status: await status.boundingBox() };
  expect(after).toEqual(before);
});
