import { test, expect, type Page } from "@playwright/test";
import { activateAgent, mockApi, resetStorage, uploadPdfFromRail } from "./helpers";

/** Select the text-layer span containing `text` on the given PDF page. */
async function selectPdfText(page: Page, text: string) {
  await expect(page.locator(".pdf-text-layer span", { hasText: text }).first()).toBeAttached({ timeout: 15_000 });
  // The text layer is rebuilt when the page re-renders (layout settling after
  // upload), which drops a selection made a moment too early: retry briefly.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.evaluate((needle) => {
      const target = Array.from(document.querySelectorAll<HTMLElement>(".pdf-text-layer span")).find((element) =>
        (element.textContent || "").includes(needle),
      );
      target?.scrollIntoView({ block: "center", behavior: "instant" });
    }, text);
    await page.waitForTimeout(250);
    await page.evaluate((needle) => {
      const span = Array.from(document.querySelectorAll<HTMLElement>(".pdf-text-layer span")).find((element) =>
        (element.textContent || "").includes(needle),
      );
      if (!span) throw new Error(`No text-layer span containing ${needle}`);
      // The viewer scrolls smoothly by default; jump so the toolbar is placed
      // against the settled position, not a mid-animation one.
      span.scrollIntoView({ block: "center", behavior: "instant" });
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, text);
    try {
      await expect(page.locator(".selection-toolbar")).toBeVisible({ timeout: 1_500 });
      return;
    } catch {
      await page.waitForTimeout(400);
    }
  }
  await expect(page.locator(".selection-toolbar")).toBeVisible({ timeout: 2_000 });
}

test.describe("PDF highlights and notes", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    await mockApi(page);
    await uploadPdfFromRail(page);
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
  });

  test("highlight and note are created from a selection and survive a reload", async ({ page }) => {
    await selectPdfText(page, "Page One");
    await page.locator(".selection-toolbar").getByRole("button", { name: /^高亮$|^Highlight$/ }).click();
    await expect(page.locator(".pdf-highlight")).toHaveCount(1);
    await expect(page.locator(".pdf-highlight").first()).toHaveAttribute("data-color", "yellow");
    // A plain highlight still gets a note card under the page.
    const firstCard = page.locator(".pdf-page-notes[data-page-number='1'] .page-note");
    await expect(firstCard).toHaveCount(1);
    await expect(firstCard.first().locator(".page-note-quote")).toContainText("Page One");

    await selectPdfText(page, "Page One");
    await page.locator(".selection-toolbar").getByRole("button", { name: /^写笔记$|^Add note$/ }).click();
    await expect(page.locator(".pdf-highlight")).toHaveCount(2);
    const focused = page.locator(".page-note-input:focus");
    await expect(focused).toHaveCount(1);
    await focused.fill("Definition to remember for the exam");
    await page.keyboard.press("Escape");
    await expect(page.locator(".page-note-input:focus")).toHaveCount(0);

    // Recolour from the card.
    await page.locator(".page-note").nth(1).locator(".page-note-color[data-color='green']").click();
    await expect(page.locator(".pdf-highlight[data-color='green']")).toHaveCount(1);

    // The document-wide index lists both entries.
    await page.locator(".tab-group").getByRole("button", { name: /^笔记$|^My notes$/ }).click();
    await expect(page.locator(".annotations-item")).toHaveCount(2);
    await expect(page.locator(".annotations-item").nth(1)).toContainText("Definition to remember");

    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForSelector(".app-shell", { timeout: 10_000 });
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".pdf-highlight")).toHaveCount(2);
    await expect(page.locator(".pdf-highlight[data-color='green']")).toHaveCount(1);
    await expect(page.locator(".page-note-input").nth(1)).toHaveValue("Definition to remember for the exam");
  });

  test("page note is added from the page footer and deleted with confirmation", async ({ page }) => {
    const pageTwoNotes = page.locator(".pdf-page-notes[data-page-number='2']");
    await pageTwoNotes.locator(".pdf-page-add-note").click();
    await expect(pageTwoNotes.locator(".page-note.page-level")).toHaveCount(1);
    await expect(page.locator(".page-note-input:focus")).toHaveCount(1);
    await page.keyboard.type("Compare with page one");
    await expect(page.locator(".pdf-highlight")).toHaveCount(0);

    const deleteButton = pageTwoNotes.locator(".page-note-delete");
    await deleteButton.click();
    await expect(deleteButton).toHaveClass(/confirming/);
    await expect(pageTwoNotes.locator(".page-note")).toHaveCount(1);
    await deleteButton.click();
    await expect(pageTwoNotes.locator(".page-note")).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForSelector(".app-shell", { timeout: 10_000 });
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".page-note")).toHaveCount(0);
  });

  test("clicking a highlight focuses its note", async ({ page }) => {
    await selectPdfText(page, "Page Two");
    await page.locator(".selection-toolbar").getByRole("button", { name: /^高亮$|^Highlight$/ }).click();
    await expect(page.locator(".pdf-highlight")).toHaveCount(1);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const highlight = page.locator(".pdf-highlight").first();
    const box = await highlight.boundingBox();
    if (!box) throw new Error("highlight has no box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".page-note-input:focus")).toHaveCount(1);
    await expect(page.locator(".page-note.active")).toHaveCount(1);
  });
});

test.describe("Notes as assistant context", () => {
  type CapturedPayload = {
    input?: string;
    context?: Array<{ type?: string; page_no?: number }>;
    selectedContext?: { pdfPageNumber?: number } | null;
  };

  async function captureChat(page: Page) {
    const captured: { last: CapturedPayload | null; all: CapturedPayload[] } = { last: null, all: [] };
    await page.unroute("**/api/**");
    await page.route("**/api/**", async (route) => {
      if (route.request().url().includes("/api/agent/chat")) {
        const payload = JSON.parse(route.request().postData() || "{}") as CapturedPayload;
        captured.last = payload;
        captured.all.push(payload);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: "好的，我看到了你的笔记。" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    return captured;
  }

  async function writeNoteOnPageOne(page: Page, text: string) {
    await selectPdfText(page, "Page One");
    await page.locator(".selection-toolbar").getByRole("button", { name: /^写笔记$|^Add note$/ }).click();
    const input = page.locator(".page-note-input:focus");
    await expect(input).toHaveCount(1);
    await input.fill(text);
    await page.keyboard.press("Escape");
  }

  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    await mockApi(page);
    await uploadPdfFromRail(page);
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
  });

  test("written notes travel with questions and quizzes, with a provenance item", async ({ page }) => {
    await writeNoteOnPageOne(page, "电场是标量");
    const captured = await captureChat(page);
    const composer = await activateAgent(page);
    await composer.fill("这一页在讲什么？");
    await page.keyboard.press("Enter");
    await expect.poll(() => captured.last?.input || "").toContain("我的笔记");
    expect(captured.last?.input).toContain("电场是标量");
    expect(captured.last?.input).toContain("p.1｜");
    expect(captured.last?.input).toContain("必须当场点出来");
    const provenance = (captured.last?.context || []).find((item) => item.type === "learner_note");
    expect(provenance?.page_no).toBe(1);

    // The challenge panel announces the targeting and the coach prompt carries the note.
    await expect(page.locator(".quiz-note-note")).toContainText(/1 条笔记|1 note/);
    await page.locator(".challenge-start").click();
    await expect.poll(() => captured.all.length).toBe(2);
    expect(captured.last?.input).toContain("我自己写的笔记");
    expect(captured.last?.input).toContain("电场是标量");
    expect(captured.last?.input).toContain("做成一个干扰项");
  });

  test("the note-check action sends a verdict prompt with the page as selected source", async ({ page }) => {
    await writeNoteOnPageOne(page, "电场是标量");
    const captured = await captureChat(page);
    await page.locator(".pdf-page-notes[data-page-number='1'] .page-note-ask").first().click();
    await expect(page.locator(".user-message")).toContainText("请检查我对这条笔记的理解");
    await expect.poll(() => captured.last?.selectedContext?.pdfPageNumber ?? null).toBe(1);
    // The backend re-wraps inputs that do not open with the selected-source header.
    expect(captured.last?.input?.startsWith("Selected source:")).toBe(true);
    expect(captured.last?.input).toContain("电场是标量");
    expect(captured.last?.input).toContain("Page One");
  });

  test("an empty page note cannot be checked until something is written", async ({ page }) => {
    const pageOneNotes = page.locator(".pdf-page-notes[data-page-number='1']");
    await pageOneNotes.locator(".pdf-page-add-note").click();
    const ask = pageOneNotes.locator(".page-note-ask");
    await expect(ask).toBeDisabled();
    await page.locator(".page-note-input:focus").fill("先看定义再看例子");
    await expect(ask).toBeEnabled();
  });

  test("with no notes the quiz prompt says so, and the opt-out removes the digest", async ({ page }) => {
    const captured = await captureChat(page);
    await activateAgent(page);
    await expect(page.locator(".quiz-note-note")).toHaveCount(0);
    await page.locator(".challenge-start").click();
    await expect.poll(() => captured.last?.input || "").toContain("这份文档我还没写下任何笔记");

    // Opt out through Settings → Assistant (the persisted settings record wins
    // over a raw localStorage edit on restore, so this is the real user path).
    await page.locator(".rail-settings-button").click();
    await page.locator(".settings-nav-item").filter({ hasText: /^助手$|^Assistant$/ }).click();
    const shareRow = page.locator(".settings-row").filter({ hasText: /把我的笔记发给助手|Share my notes with the assistant/ });
    await expect(shareRow.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await shareRow.getByRole("switch").click();
    await expect(shareRow.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-dialog")).toHaveCount(0);
    await writeNoteOnPageOne(page, "电场是标量");
    const optedOut = await captureChat(page);
    const composer = await activateAgent(page);
    await composer.fill("这一页在讲什么？");
    await page.keyboard.press("Enter");
    await expect.poll(() => optedOut.all.length).toBe(1);
    expect(optedOut.last?.input).toContain("这一页在讲什么");
    expect(optedOut.last?.input).not.toContain("我的笔记");
    expect((optedOut.last?.context || []).some((item) => item.type === "learner_note")).toBe(false);
    await expect(page.locator(".pdf-page-notes[data-page-number='1'] .page-note-ask")).toHaveCount(1);
  });
});
