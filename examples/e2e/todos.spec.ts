import { test, expect } from "@playwright/test";

test("sample app loads", async ({ page }) => {
  await page.goto("/todos");
  await expect(page.getByTestId("todo-input")).toBeVisible();
});
