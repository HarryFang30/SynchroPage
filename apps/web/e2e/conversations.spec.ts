import { test, expect, type Page } from "@playwright/test";
import { activateAgent, resetStorage, uploadPdfFromRail } from "./helpers";

type ChatPayload = {
  input?: string;
  selectedContext?: { text?: string } | null;
  page?: { page_no?: number };
  messages?: { role: string; status?: string; content: string; page_no?: number; quote?: string }[];
};

/** Answers every chat request with `reply(question)` and records what was sent. */
async function mockChat(page: Page, options: { delayMs?: number } = {}) {
  const payloads: ChatPayload[] = [];
  await page.route("**/api/**", async (route) => {
    if (!route.request().url().includes("/api/agent/chat")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    const payload = route.request().postDataJSON() as ChatPayload;
    payloads.push(payload);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ content: `Reply to: ${payload.input}` }),
      })
      .catch(() => undefined);
  });
  return payloads;
}

async function openDocument(page: Page) {
  await uploadPdfFromRail(page);
  await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".topbar-page-nav output")).toContainText("1 / 2", { timeout: 10_000 });
  return activateAgent(page);
}

async function ask(page: Page, question: string) {
  const composer = page.locator(".aui-composer-input");
  await composer.click();
  await composer.fill(question);
  await page.keyboard.press("Enter");
  await expect(page.locator(".assistant-message").last()).toContainText(`Reply to: ${question}`, { timeout: 10_000 });
}

function newChatButton(page: Page) {
  return page.locator(".agent-toolbar .agent-action-button").and(page.getByRole("button", { name: /新对话|New chat/ }));
}

/** Reload and get back to the assistant once the workspace has been restored. */
async function reloadToAssistant(page: Page) {
  await page.reload();
  await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
  await activateAgent(page);
}

/** Select the text-layer span containing `text` and wait for the selection toolbar. */
async function selectPdfText(page: Page, text: string) {
  await expect(page.locator(".pdf-text-layer span", { hasText: text }).first()).toBeAttached({ timeout: 15_000 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.evaluate((needle) => {
      const span = Array.from(document.querySelectorAll<HTMLElement>(".pdf-text-layer span")).find((element) =>
        (element.textContent || "").includes(needle),
      );
      if (!span) throw new Error(`No text-layer span containing ${needle}`);
      span.scrollIntoView({ block: "center", behavior: "instant" });
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, text);
    if (await page.locator(".selection-toolbar").isVisible().catch(() => false)) return;
    await page.waitForTimeout(400);
  }
  await expect(page.locator(".selection-toolbar")).toBeVisible({ timeout: 2_000 });
}

async function openHistory(page: Page) {
  await page.locator(".agent-toolbar").getByRole("button", { name: /历史对话|Chat history/ }).last().click();
  const history = page.locator(".conversation-history");
  await expect(history).toBeVisible();
  return history;
}

test.describe("Assistant conversations", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("a new chat keeps the earlier one: it is listed, reopens with its messages, and survives a reload", async ({ page }) => {
    await mockChat(page);
    await openDocument(page);
    await ask(page, "经验风险是什么");
    await expect(page.locator(".conversation-switcher-title")).toHaveText("经验风险是什么");

    await newChatButton(page).click();
    await expect(page.locator(".user-message")).toHaveCount(0);
    await expect(page.locator(".conversation-switcher-title")).toHaveText(/新对话|New chat/);
    // The empty chat shows where the earlier one went.
    const recent = page.locator(".recent-conversations .recent-conversation");
    await expect(recent).toHaveCount(1);
    await expect(recent.first()).toContainText("经验风险是什么");
    await expect(recent.first()).toContainText("p.1");

    await ask(page, "岭回归为什么要加惩罚项");
    const history = await openHistory(page);
    const rows = history.locator(".conversation-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("岭回归为什么要加惩罚项");
    await expect(rows.nth(0)).toHaveClass(/active/);
    await expect(rows.nth(1)).toContainText("经验风险是什么");

    await rows.nth(1).locator(".conversation-open").click();
    await expect(history).toHaveCount(0);
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(page.locator(".user-message").first()).toContainText("经验风险是什么");
    await expect(page.locator(".assistant-message").first()).toContainText("Reply to: 经验风险是什么");
    await expect(page.locator(".conversation-switcher-title")).toHaveText("经验风险是什么");

    // The conversation that was open is the one that comes back.
    await reloadToAssistant(page);
    await expect(page.locator(".user-message").first()).toContainText("经验风险是什么", { timeout: 10_000 });
    await expect(page.locator(".user-message")).toHaveCount(1);
  });

  test("starting a new chat twice does not pile up empty conversations", async ({ page }) => {
    await mockChat(page);
    await openDocument(page);
    await ask(page, "第一个问题");
    const newChat = newChatButton(page);
    await newChat.click();
    await newChat.click();
    await newChat.click();
    const history = await openHistory(page);
    await expect(history.locator(".conversation-row")).toHaveCount(1);
  });

  test("a question keeps the page it was asked from, and the request says so", async ({ page }) => {
    const payloads = await mockChat(page);
    await openDocument(page);
    await ask(page, "这一页在讲什么");

    await page.locator(".topbar-page-nav").getByRole("button", { name: /下一页|Next page/i }).click();
    await expect(page.locator(".topbar-page-nav output")).toContainText("2 / 2", { timeout: 10_000 });
    // The composer shows what the next question will be about.
    await expect(page.locator(".composer-page-pill")).toContainText("p.2");
    await ask(page, "那这一页呢");

    const users = page.locator(".user-message");
    await expect(users.nth(0).locator(".message-page-chip")).toContainText("p.1");
    await expect(users.nth(1).locator(".message-page-chip")).toContainText("p.2");

    expect(payloads).toHaveLength(2);
    expect(payloads[0].messages).toEqual([]);
    expect(payloads[1].page?.page_no).toBe(2);
    expect(payloads[1].input).toBe("那这一页呢");
    // Earlier turns only: the question being asked is not repeated in the transcript.
    expect(payloads[1].messages?.map((message) => [message.role, message.content, message.page_no])).toEqual([
      ["user", "这一页在讲什么", 1],
      ["assistant", "Reply to: 这一页在讲什么", undefined],
    ]);

    // The chip leads back to the page the question was about.
    await users.nth(0).locator(".message-page-chip").click();
    await expect(page.locator(".topbar-page-nav output")).toContainText("1 / 2", { timeout: 10_000 });

    // Restored messages keep their page.
    await reloadToAssistant(page);
    await expect(page.locator(".user-message").nth(1).locator(".message-page-chip")).toContainText("p.2", { timeout: 10_000 });
  });

  test("editing a question sends it again and replaces what came after it", async ({ page }) => {
    const payloads = await mockChat(page);
    await openDocument(page);
    await ask(page, "什么是过拟合");
    await ask(page, "怎么避免");

    const first = page.locator(".user-message").first();
    await first.hover();
    await first.getByRole("button", { name: /编辑|Edit/ }).click();
    const editor = page.locator(".edit-composer-input");
    await expect(editor).toHaveValue("什么是过拟合");
    await editor.fill("什么是欠拟合");
    await page.keyboard.press("Enter");

    await expect(page.locator(".assistant-message").last()).toContainText("Reply to: 什么是欠拟合", { timeout: 10_000 });
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(page.locator(".assistant-message")).toHaveCount(1);
    expect(payloads.at(-1)?.input).toBe("什么是欠拟合");
    expect(payloads.at(-1)?.messages).toEqual([]);
    await expect(page.locator(".conversation-switcher-title")).toHaveText("什么是欠拟合");

    // What is stored is what is on screen.
    await reloadToAssistant(page);
    await expect(page.locator(".user-message").first()).toContainText("什么是欠拟合", { timeout: 10_000 });
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(page.locator(".assistant-message")).toHaveCount(1);
  });

  test("cancelling an edit leaves the conversation as it was", async ({ page }) => {
    const payloads = await mockChat(page);
    await openDocument(page);
    await ask(page, "什么是过拟合");
    const first = page.locator(".user-message").first();
    await first.hover();
    await first.getByRole("button", { name: /编辑|Edit/ }).click();
    await page.locator(".edit-composer-input").fill("改了一半");
    await page.locator(".edit-composer").getByRole("button", { name: /取消|Cancel/ }).click();
    await expect(page.locator(".edit-composer")).toHaveCount(0);
    await expect(page.locator(".user-message").first()).toContainText("什么是过拟合");
    expect(payloads).toHaveLength(1);
  });

  test("regenerating an answer replaces it instead of keeping both", async ({ page }) => {
    await mockChat(page);
    await openDocument(page);
    await ask(page, "什么是过拟合");
    const answer = page.locator(".assistant-message").first();
    await answer.hover();
    await answer.getByRole("button", { name: /重新生成|Regenerate/ }).click();
    await expect(page.locator(".assistant-message").last()).toContainText("Reply to: 什么是过拟合", { timeout: 10_000 });
    await expect(page.locator(".branch-picker")).toHaveCount(0);

    await reloadToAssistant(page);
    await expect(page.locator(".user-message")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".assistant-message")).toHaveCount(1);
  });

  test("a conversation can be renamed, found by what was said in it, and deleted", async ({ page }) => {
    await mockChat(page);
    await openDocument(page);
    await ask(page, "什么是过拟合");
    await ask(page, "正则化系数怎么选");
    await newChatButton(page).click();
    await ask(page, "梯度下降的步长");

    let history = await openHistory(page);
    // The second question of the first chat is not in its title, only in its messages.
    await history.locator("#conversation-history-search").fill("正则化");
    await expect(history.locator(".conversation-row")).toHaveCount(1);
    await expect(history.locator(".conversation-row").first()).toContainText("什么是过拟合");
    await history.locator("#conversation-history-search").fill("不存在的内容");
    await expect(history.locator(".conversation-empty")).toBeVisible();
    await history.locator("#conversation-history-search").fill("");
    await expect(history.locator(".conversation-row")).toHaveCount(2);

    const older = history.locator(".conversation-row").filter({ hasText: "什么是过拟合" });
    await older.hover();
    await older.getByRole("button", { name: /重命名|Rename/ }).click();
    const titleInput = history.locator(".conversation-row.editing input");
    await titleInput.fill("过拟合与正则化");
    await page.keyboard.press("Enter");
    await expect(history.locator(".conversation-row").filter({ hasText: "过拟合与正则化" })).toHaveCount(1);

    // A renamed chat keeps its name when more is asked in it.
    await history.locator(".conversation-row").filter({ hasText: "过拟合与正则化" }).locator(".conversation-open").click();
    await ask(page, "再举个例子");
    await expect(page.locator(".conversation-switcher-title")).toHaveText("过拟合与正则化");

    // Deleting the open chat leaves a fresh one and the other chat untouched.
    history = await openHistory(page);
    const open = history.locator(".conversation-row.active");
    await open.hover();
    await open.getByRole("button", { name: /删除|Delete/ }).click();
    await history.locator(".conversation-row.confirming").getByRole("button", { name: /^删除$|^Delete$/ }).click();
    await expect(page.locator(".user-message")).toHaveCount(0);
    history = await openHistory(page);
    await expect(history.locator(".conversation-row")).toHaveCount(1);
    await expect(history.locator(".conversation-row").first()).toContainText("梯度下降的步长");
    await page.keyboard.press("Escape");
    await expect(page.locator(".conversation-history")).toHaveCount(0);
    await expect(page.locator(".user-message")).toHaveCount(0);
  });

  test("a question about a selection keeps the selection: on the message, in the title, in later requests", async ({ page }) => {
    const payloads = await mockChat(page);
    await openDocument(page);
    await selectPdfText(page, "Page One");
    await page.locator(".selection-toolbar").getByRole("button", { name: /解释选中内容|Explain selection/ }).click();
    await expect(page.locator(".assistant-message").last()).toContainText("Reply to:", { timeout: 10_000 });

    const first = page.locator(".user-message").first();
    await expect(first.locator(".message-quote")).toContainText("Page One");
    await expect(first.locator(".message-page-chip")).toContainText("p.1");
    expect(payloads[0].selectedContext?.text).toBe("Page One");
    await expect(page.locator(".conversation-switcher-title")).toContainText("Page One");

    // Asking again is asking about the same selection, although the composer no longer holds it.
    await expect(page.locator(".composer-shell .selected-source-preview")).toHaveCount(0);
    const answer = page.locator(".assistant-message").first();
    await answer.hover();
    await answer.getByRole("button", { name: /重新生成|Regenerate/ }).click();
    await expect.poll(() => payloads.length, { timeout: 10_000 }).toBe(2);
    expect(payloads[1].selectedContext?.text).toBe("Page One");
    await expect(page.locator(".assistant-footer").last()).toBeVisible({ timeout: 10_000 });

    // The follow-up has no selection of its own; the transcript says what the first turn was about.
    await ask(page, "再讲细一点");
    expect(payloads[2].selectedContext).toBeNull();
    expect(payloads[2].messages?.[0]).toMatchObject({ role: "user", page_no: 1, quote: "Page One" });

    // The quote is still on the message after a reload, and an edited question is still about it.
    await reloadToAssistant(page);
    const restored = page.locator(".user-message").first();
    await expect(restored.locator(".message-quote")).toContainText("Page One", { timeout: 10_000 });
    await restored.hover();
    await restored.getByRole("button", { name: /编辑|Edit/ }).click();
    await expect(page.locator(".edit-composer .message-quote")).toContainText("Page One");
    await page.locator(".edit-composer-input").fill("用一句话解释");
    await page.keyboard.press("Enter");
    await expect.poll(() => payloads.length, { timeout: 10_000 }).toBe(4);
    expect(payloads[3].input).toContain("用一句话解释");
    expect(payloads[3].selectedContext?.text).toBe("Page One");
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(page.locator(".user-message").first().locator(".message-quote")).toContainText("Page One");
  });

  test("an answer that arrives while the panel is hidden is there when the panel comes back", async ({ page }) => {
    await mockChat(page, { delayMs: 1_500 });
    await openDocument(page);
    const composer = page.locator(".aui-composer-input");
    await composer.click();
    await composer.fill("慢问题");
    await page.keyboard.press("Enter");
    await expect(page.locator(".user-message")).toHaveCount(1);
    await page.getByRole("button", { name: /隐藏助手|Hide assistant/i }).click();
    await expect(page.locator(".agent-panel")).toHaveCount(0);
    await page.waitForTimeout(2_500);
    await activateAgent(page);
    await expect(page.locator(".assistant-message").first()).toContainText("Reply to: 慢问题", { timeout: 10_000 });
  });

  test("an answer can be stopped, and the composer is ready for the next question", async ({ page }) => {
    await mockChat(page, { delayMs: 4_000 });
    await openDocument(page);
    const composer = page.locator(".aui-composer-input");
    await composer.click();
    await composer.fill("慢问题");
    await page.keyboard.press("Enter");
    const stop = page.locator(".composer-stop");
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await expect(page.locator(".composer-send")).toBeVisible();
    await expect(page.locator(".assistant-message").last()).toContainText(/生成已停止|Generation stopped/);
  });

  test("an answer that arrives after a new chat was started stays out of the new chat", async ({ page }) => {
    await mockChat(page, { delayMs: 1_500 });
    await openDocument(page);
    const composer = page.locator(".aui-composer-input");
    await composer.click();
    await composer.fill("慢问题");
    await page.keyboard.press("Enter");
    await expect(page.locator(".user-message")).toHaveCount(1);
    await newChatButton(page).click();
    await expect(page.locator(".user-message")).toHaveCount(0);
    await page.waitForTimeout(2_500);

    // Remounting the panel shows the stored state of the open chat: still empty.
    await page.getByRole("button", { name: /隐藏助手|Hide assistant/i }).click();
    await expect(page.locator(".agent-panel")).toHaveCount(0);
    await activateAgent(page);
    await expect(page.locator(".user-message")).toHaveCount(0);
    await expect(page.locator(".assistant-message")).toHaveCount(0);

    // The question is where it was asked.
    const history = await openHistory(page);
    await expect(history.locator(".conversation-row")).toHaveCount(1);
    await history.locator(".conversation-row .conversation-open").first().click();
    await expect(page.locator(".user-message").first()).toContainText("慢问题");
    // It was answered in the background, in the conversation it belongs to.
    await expect(page.locator(".assistant-message").first()).toContainText("Reply to: 慢问题");
  });
});
