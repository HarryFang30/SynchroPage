import { test, expect } from "@playwright/test";
import { activateAgent, resetStorage, mockApi } from "./helpers";

test.describe("Agent Panel", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    // Mock all API calls so the agent doesn't need a real backend
    await mockApi(page, {
      "/api/agent/chat": { content: "Mock assistant reply from e2e." },
    });
  });

  test("agent panel is present", async ({ page }) => {
    await activateAgent(page);
    await expect(page.locator(".agent-panel")).toBeVisible();
  });

  test("agent toolbar shows model label", async ({ page }) => {
    await activateAgent(page);
    const toolbar = page.locator(".agent-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator(".toolbar-title")).toBeVisible();
    await expect(toolbar.locator(".agent-model")).toHaveText(/OAuth|Local/);
  });

  test("composer input accepts text", async ({ page }) => {
    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Hello, this is a test message");
    await expect(composer).toHaveValue("Hello, this is a test message");
  });

  test("composer send button exists", async ({ page }) => {
    await activateAgent(page);
    await expect(page.locator(".composer-send")).toBeVisible();
  });

  test("agent welcome message is shown when empty", async ({ page }) => {
    await activateAgent(page);
    await expect(page.locator(".aui-welcome")).toBeVisible();
    await expect(page.locator(".prompt-suggestions button")).toHaveCount(4);
  });

  test("sending a message via Enter renders mocked assistant reply", async ({ page }) => {
    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Test message from e2e");
    await page.keyboard.press("Enter");

    await expect(page.locator(".user-message")).toContainText("Test message from e2e");
    await expect(page.locator(".assistant-message")).toContainText("Mock assistant reply from e2e.", { timeout: 10_000 });
  });

  test("adding an image shows the preview inside the composer", async ({ page }) => {
    await activateAgent(page);
    const imageInput = page.locator('.agent-action-button input[type="file"][accept="image/*"]');
    await expect(imageInput).toHaveCount(1);
    await imageInput.setInputFiles({
      name: "image.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lL+J+wAAAABJRU5ErkJggg==",
        "base64",
      ),
    });

    const composerShell = page.locator(".composer-shell");
    await expect(composerShell.locator(".composer-attachment-preview")).toBeVisible();
    await expect(composerShell.locator(".composer-image-preview")).toContainText("image.png");
  });
});
