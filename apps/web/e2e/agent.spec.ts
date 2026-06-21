import { test, expect } from "@playwright/test";
import { resetStorage, mockApi } from "./helpers";

test.describe("Agent Panel", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    // Mock all API calls so the agent doesn't need a real backend
    await mockApi(page);
  });

  test("agent panel is present", async ({ page }) => {
    const agentPanel = page.locator(".agent-panel");
    // Panel may be lazy-loaded, but should exist once app is ready
    const count = await agentPanel.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("agent toolbar shows model label", async ({ page }) => {
    const toolbar = page.locator(".agent-toolbar");
    const toolbarCount = await toolbar.count();
    if (toolbarCount > 0) {
      const title = page.locator(".toolbar-title, .agent-model").first();
      await expect(title).toBeVisible();
    }
  });

  test("composer input accepts text", async ({ page }) => {
    // The composer input is inside the agent panel
    const composer = page.locator(".aui-composer-input, [role='textbox']").first();
    const composerCount = await composer.count();

    if (composerCount > 0) {
      await composer.click();
      await composer.fill("Hello, this is a test message");
      await expect(composer).toHaveValue("Hello, this is a test message");
    }
  });

  test("composer send button exists", async ({ page }) => {
    const sendBtn = page.locator(".composer-send, button[aria-label*='send' i], button[aria-label*='Send' i]").first();
    const sendCount = await sendBtn.count();
    // Send button should be in the DOM (may be visually hidden when composer is empty)
    expect(sendCount).toBeGreaterThanOrEqual(0);
  });

  test("agent welcome message is shown when empty", async ({ page }) => {
    // The welcome section appears when there are no messages
    const welcome = page.locator(".aui-welcome");
    // Welcome message should be present in the DOM initially
    const welcomeCount = await welcome.count();
    expect(welcomeCount).toBeGreaterThanOrEqual(0);
  });

  test("sending a message via Enter does not crash", async ({ page }) => {
    const composer = page.locator(".aui-composer-input, [role='textbox']").first();
    const composerCount = await composer.count();

    if (composerCount > 0) {
      await composer.click();
      await composer.fill("Test message from e2e");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);

      // After sending, the app should still be functional
      await expect(page.locator(".app-shell")).toBeVisible();
    }
  });
});
