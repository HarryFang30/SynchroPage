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

  test("challenge panel sends the current-page challenge coach prompt", async ({ page }) => {
    await page.unroute("**/api/**");
    let requestPayload: { input?: string; messages?: Array<{ content?: string }> } | null = null;
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/agent/chat")) {
        requestPayload = JSON.parse(route.request().postData() || "{}") as typeof requestPayload;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            content: JSON.stringify({
              type: "synchropage.challenge_quiz.v1",
              title: "Attention Mechanism Quiz",
              knowledge_type: "concept",
              challenge_type: "概念边界题",
              question: "什么是注意力机制的核心思想？",
              options: [
                { id: "A", text: "将所有输入序列无差别地压缩成一个固定长度向量。" },
                { id: "B", text: "随机丢弃一部分神经元以防止过拟合。" },
                { id: "C", text: "根据当前任务动态分配不同输入位置的权重。" },
                { id: "D", text: "通过固定窗口卷积提取局部空间特征。" },
              ],
              correct_option_id: "C",
              feedback: {
                correct: "对，关键是动态加权。",
                incorrect: "这个选项没有抓住注意力的动态权重分配。",
              },
              explanation: "注意力机制允许模型根据查询和上下文决定关注哪些输入。",
              follow_up: "如果所有位置权重都相同，还算有效注意力吗？",
            }),
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await activateAgent(page);
    await expect(page.locator(".challenge-panel")).toBeVisible();
    await page.locator(".challenge-start").click();

    await expect(page.locator(".user-message")).toContainText(/Challenge/i);
    const quiz = page.locator(".challenge-quiz-card");
    await expect(quiz).toBeVisible({ timeout: 10_000 });
    await expect(quiz).toContainText("Attention Mechanism Quiz");
    await expect(quiz.locator(".challenge-option")).toHaveCount(4);
    await quiz.locator(".challenge-option").filter({ hasText: "随机丢弃" }).click();
    await expect(quiz.locator(".challenge-option.incorrect")).toContainText("B");
    await expect(quiz.locator(".challenge-option.correct")).toContainText("C");
    await expect(quiz.locator(".challenge-feedback")).toContainText("正确选项");
    await expect(quiz.locator(".challenge-feedback")).toContainText("追问");
    await expect(quiz.locator(".challenge-next")).toContainText("下一题");
    await expect.poll(() => requestPayload?.input || "").toContain("你是我的理工科 PPT 挑战教练");
    await expect.poll(() => requestPayload?.input || "").toContain("当前挑战模式");
    await expect.poll(() => requestPayload?.input || "").toContain("synchropage.challenge_quiz.v1");
    await expect.poll(() => requestPayload?.messages?.at(-1)?.content || "").toContain("Challenge");
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

  test("renders table math with vertical bars without splitting columns", async ({ page }) => {
    await page.unroute("**/api/**");
    await mockApi(page, {
      "/api/agent/chat": {
        content: [
          "| 比较项 | $T = 3$ | $T = 7$ |",
          "| --- | --- | --- |",
          "| 时域持续时间 | 较短 | 较长 |",
          "| 能量密度 | $|X(\\omega)|^2$ | $|Y(\\omega)|^2$ |",
        ].join("\n"),
      },
    });

    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Render table math");
    await page.keyboard.press("Enter");

    const assistant = page.locator(".assistant-message").last();
    const rows = assistant.locator("table tr");
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(rows.nth(2).locator("td")).toHaveCount(3);
    await expect(assistant.locator(".katex-error")).toHaveCount(0);
    await expect(assistant).not.toContainText("$|X");
    await expect(assistant).not.toContainText("^2$");
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
