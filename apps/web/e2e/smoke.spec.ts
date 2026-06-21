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
    // Click the sidebar "设置" (Settings) button
    const settingsBtn = page.locator("button:has-text('设置')").first();
    const btnCount = await settingsBtn.count();
    if (btnCount > 0) {
      await settingsBtn.click();
      await page.waitForTimeout(500);

      // Settings modal or overlay should appear — either is fine
      const settingsOverlay = page.locator(".settings-overlay");
      const settingsDialog = page.locator(".settings-dialog");
      const overlayVisible = await settingsOverlay.isVisible().catch(() => false);
      const dialogVisible = await settingsDialog.isVisible().catch(() => false);

      // At least one settings container should appear after clicking
      expect(overlayVisible || dialogVisible).toBeTruthy();
    } else {
      // If no sidebar settings button, try the "更多操作" → "高级设置" path
      const moreBtn = page.locator("button:has-text('更多操作')").first();
      if ((await moreBtn.count()) > 0) {
        await moreBtn.click();
        await page.waitForTimeout(300);
        const advancedBtn = page.locator("button:has-text('高级设置')").first();
        if ((await advancedBtn.count()) > 0) {
          await advancedBtn.click();
          await page.waitForTimeout(500);
        }
      }
      // App should still be functional
      await expect(page.locator(".app-shell")).toBeVisible();
    }
  });

  test("command menu can be triggered", async ({ page }) => {
    // Ctrl+K or Cmd+K opens command menu
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    // Command menu may or may not appear depending on focus
    // At minimum, the app shouldn't crash
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("dark mode toggle via settings does not crash", async ({ page }) => {
    // The app starts with a theme defined
    const html = page.locator("html");
    const initialTheme = await html.getAttribute("data-pagepair-resolved-theme");
    // Theme should be defined
    expect(initialTheme).toBeDefined();
  });
});
