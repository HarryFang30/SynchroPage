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

  test("renders malformed inline math from model replies", async ({ page }) => {
    await page.unroute("**/api/**");
    await mockApi(page, {
      "/api/agent/chat": {
        content: [
          "若系统只允许 $0, 1, 2, 3, 4$ 这些值,那么可选状态就是有限集合。",
          "结果通常是近似值,例如 ((0.715)10 $\\to (0.10110$......)2,因为小数可能无法有限表示。",
          "每一位的权值是 `16^0, 16^1, 16^2, ...`,和十进制一致。",
          "例子 `E $\\times 16^2 + 3 \\times 16^1 +$ A $\\times 16^0$`。",
          "$- \\text{组合电路可以看成}“\\text{当前输入} $$\\to$$$ 当前输出”的直接映射。",
          "严格地说,应写作 T(n) $$\\in$$ O(f(n)),表示 $T(n)$ 属于这个集合。",
        ].join("\\n"),
      },
    });

    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Render math");
    await page.keyboard.press("Enter");

    const assistant = page.locator(".assistant-message").last();
    await expect(assistant.locator(".katex")).toHaveCount(7, { timeout: 10_000 });
    await expect(assistant.locator(".katex-error")).toHaveCount(0);
    await expect(assistant.locator("code")).toHaveCount(0);
    await expect(assistant).not.toContainText("$0, 1, 2, 3, 4$");
    await expect(assistant).not.toContainText("$\\to");
    await expect(assistant).not.toContainText("$-");
    await expect(assistant).not.toContainText("\\text{组合电路");
    await expect(assistant).not.toContainText("$$\\to$$$");
    await expect(assistant).not.toContainText("$$\\in$$");
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
