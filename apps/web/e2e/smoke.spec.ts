import { test, expect } from "@playwright/test";
import { resetStorage } from "./helpers";

test.describe("Smoke", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("app shell renders", async ({ page }) => {
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("topbar is visible with brand", async ({ page }) => {
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.locator(".brand")).toBeVisible();
  });

  test("settings button opens settings dialog", async ({ page }) => {
    await page.locator(".rail-settings-button").click();
    await expect(page.locator(".settings-overlay")).toBeVisible();
    await expect(page.locator(".settings-dialog")).toBeVisible();
    await expect(page.locator(".settings-nav-item")).toHaveCount(7);
  });

  test("command menu opens and shows actions", async ({ page }) => {
    await page.locator(".command-menu > .mini-button").click();
    const menu = page.locator(".command-menu-popover");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button")).toHaveCount(4);
    await expect(menu).toContainText(/OpenAI|OAuth/i);
  });

  test("theme data attributes are initialized", async ({ page }) => {
    const html = page.locator("html");
    const initialTheme = await html.getAttribute("data-synchropage-resolved-theme");
    expect(["light", "dark"]).toContain(initialTheme);
  });
});
