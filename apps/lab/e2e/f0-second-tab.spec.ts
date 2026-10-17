import { expect, test } from "@playwright/test";
import { openWorkspace, waitForStorageReady } from "./helpers.ts";

// F0 acceptance: opening the app in a second tab shows a clear "database in use" state instead of failing.
test("a second tab shows 'database in use', then takes over when the first tab closes", async ({ context }) => {
  const first = await context.newPage();
  await first.goto("/");
  await waitForStorageReady(first);

  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByTestId("db-in-use")).toContainText("Database in use in another tab");
  await expect(second.getByTestId("status-storage")).toHaveText("db: waiting-lock");
  // The rest of the app still works in the second tab.
  await expect(second.getByTestId("scene-canvas")).toBeVisible();
  await openWorkspace(second, "data");
  await expect(second.getByTestId("storage-unavailable")).toContainText("owned by another tab");

  await first.close();
  await waitForStorageReady(second);
  await expect(second.getByTestId("db-in-use")).toHaveCount(0);
  await expect(second.getByTestId("storage-browser")).toBeVisible();
});
