import { test, expect, type Page, type Route } from "@playwright/test";
import { activateAgent, resetStorage, uploadPdfFromRail } from "./helpers";
import { composerTextWithPrefill } from "../src/lib/assistant/composerText";
import { thinkFirstApplies } from "../src/lib/learning/thinkFirst";
import type { PageData } from "../src/lib/generation/teachingGeneration";

type ChatPayload = { input?: string; answerMode?: string; explanationRead?: boolean; selectedContext?: { text?: string } | null };

const QUESTION = "为什么叶函数里的 caller-saved 寄存器可以不保存？";
const PAGE_TWO_NOTES = "叶函数体内没有调用点，所以没有需要跨调用保住的值。These mocked notes are long enough to pass every quality floor.";
const PAGE_ONE_NOTES = "第 7 讲，链接。";

function generatedPage(pageNo: number) {
  return {
    page_no: pageNo,
    teaching: {
      slide_title: pageNo === 1 ? "Lecture 7" : "Leaf functions",
      speaker_notes_md: pageNo === 1 ? PAGE_ONE_NOTES : PAGE_TWO_NOTES,
      question: pageNo === 1 ? "" : QUESTION,
      point: pageNo === 1 ? "" : "叶函数没有调用点。",
      confidence: 0.9,
      concepts: pageNo === 1 ? [] : ["leaf function"],
      output_language: "zh-CN",
    },
    status: "completed",
  };
}

const plan = {
  plan: {
    version: "synchropage.lesson-plan.v1",
    document_summary: "Two pages.",
    segments: [{ id: 1, title: "Opening", goal: "Know leaf functions.", pages: [1, 2] }],
    pages: [
      { page_no: 1, segment: 1, role: "title", depth: "skim", key: false, cue: "cover" },
      { page_no: 2, segment: 1, role: "concept", depth: "full", key: true, cue: "leaf functions" },
    ],
  },
};

/** Generation, planning and chat are answered locally; every chat request is recorded. */
async function mockBackend(page: Page) {
  const chats: ChatPayload[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/api/generate/plan")) return json(plan);
    if (url.includes("/api/generate/pages")) return json({ pages: [generatedPage(1), generatedPage(2)] });
    if (url.includes("/api/generate/page")) {
      const body = route.request().postDataJSON() as { page?: { page_no?: number } };
      return json({ page: generatedPage(body.page?.page_no || 1) });
    }
    if (url.includes("/api/agent/chat")) {
      chats.push(route.request().postDataJSON() as ChatPayload);
      return json({ content: "你先想想：bar() 调用前后，r1 里的值谁还要用？" });
    }
    return json({});
  });
  return chats;
}

async function openGeneratedDocument(page: Page) {
  await uploadPdfFromRail(page);
  await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
  await page.locator(".generate-main-button").click();
  await expect(page.locator(".generate-main-button")).toContainText(/备课|Prepare/, { timeout: 15_000 });
  await expect(page.locator(".notes-content")).toContainText(PAGE_ONE_NOTES, { timeout: 10_000 });
  // A page turn in the first moments after a planned generation finishes is
  // swallowed by the viewer (also on master); let it settle first.
  await page.waitForTimeout(1_500);
}

async function goToPageTwo(page: Page) {
  const output = page.locator(".topbar-page-nav output");
  // After a reload the saved reading position may already be page 2.
  if (!(await output.innerText()).includes("2 / 2")) {
    await page.locator(".topbar-page-nav").getByRole("button", { name: /下一页|Next page/i }).click();
  }
  await expect(output).toContainText("2 / 2", { timeout: 10_000 });
}

function explanationTab(page: Page) {
  return page.locator(".side-tabs").getByRole("tab", { name: /^讲解$|^Notes$/ });
}

test.describe("Think first", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("a skimmed page opens at once; a real page asks its question first and keeps the answer as a note", async ({ page }) => {
    await mockBackend(page);
    await openGeneratedDocument(page);
    await expect(page.locator(".think-first")).toHaveCount(0);

    await goToPageTwo(page);
    const notes = page.locator(".notes-content");
    await expect(notes.locator(".think-first-question")).toHaveText(QUESTION);
    await expect(notes).not.toContainText(PAGE_TWO_NOTES);
    await expect(notes.locator(".think-first-veil")).toBeVisible();
    await expect(notes.locator(".think-first-submit")).toBeDisabled();

    await notes.locator(".think-first-input").fill("因为叶函数不会再调用别人");
    await notes.locator(".think-first-submit").click();
    await expect(notes).toContainText(PAGE_TWO_NOTES);
    await expect(notes.locator(".think-first-recap-text")).toHaveText("因为叶函数不会再调用别人");

    // The answer is a page note that remembers its question.
    const pageNote = page.locator(".pdf-page-notes[data-page-number='2'] .page-note").first();
    await expect(pageNote.locator(".page-note-prompt")).toContainText(QUESTION);
    await expect(pageNote.locator(".page-note-input")).toHaveValue("因为叶函数不会再调用别人");

    // Still open after a reload: the note is there, so the page counts as thought through.
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await goToPageTwo(page);
    await expect(page.locator(".notes-content")).toContainText(PAGE_TWO_NOTES, { timeout: 10_000 });
    await expect(page.locator(".think-first-recap-text")).toHaveText("因为叶函数不会再调用别人");
  });

  test("the page's own question survives a reload (and the autosave that follows it)", async ({ page }) => {
    await mockBackend(page);
    await openGeneratedDocument(page);
    for (let round = 0; round < 2; round += 1) {
      await page.waitForTimeout(1_200);
      await page.reload();
      await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
      await goToPageTwo(page);
      await expect(page.locator(".notes-content .think-first-question")).toHaveText(QUESTION, { timeout: 10_000 });
    }
  });

  test("“just show me” opens the explanation without writing, offers to say it back, and stays open", async ({ page }) => {
    await mockBackend(page);
    await openGeneratedDocument(page);
    await goToPageTwo(page);
    const notes = page.locator(".notes-content");
    await notes.locator(".think-first").getByRole("button", { name: /直接看讲解|Just show me/ }).click();
    await expect(notes).toContainText(PAGE_TWO_NOTES);
    await expect(notes.locator(".think-first")).toHaveCount(0);

    await notes.getByRole("button", { name: /复述|Say it back/ }).click();
    // The box opens where the learner is, with the focus in it.
    await expect(notes.locator(".think-first-input")).toBeFocused();
    await notes.locator(".think-first-input").fill("没有调用点");
    await notes.locator(".think-first-submit").click();
    await expect(notes.locator(".think-first-recap-text")).toHaveText("没有调用点");
    // Written after reading, it is labelled as a say-back, not a prediction.
    await expect(notes.locator(".think-first-recap")).toContainText(/我的复述|In my words/);
    await expect(page.locator(".pdf-page-notes[data-page-number='2'] .page-note-prompt")).toContainText(/读完讲解后的复述|Said back after reading/);

    await page.reload();
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await goToPageTwo(page);
    await expect(page.locator(".notes-content")).toContainText(PAGE_TWO_NOTES, { timeout: 10_000 });
  });

  test("while the explanation is still closed the assistant is told the learner has not read it", async ({ page }) => {
    const chats = await mockBackend(page);
    await openGeneratedDocument(page);
    await goToPageTwo(page);
    const composer = await activateAgent(page);
    await composer.fill("这一页在讲什么？");
    await page.keyboard.press("Enter");
    await expect.poll(() => chats.length).toBe(1);
    expect(chats[0].explanationRead).toBe(false);
    expect(chats[0].answerMode).toBe("coach");

    await explanationTab(page).click();
    await page.locator(".think-first").getByRole("button", { name: /直接看讲解|Just show me/ }).click();
    const again = await activateAgent(page);
    await again.fill("再问一次");
    await page.keyboard.press("Enter");
    await expect.poll(() => chats.length).toBe(2);
    expect("explanationRead" in chats[1]).toBe(false);
  });

  test("with think-first switched off in Settings, explanations open directly", async ({ page }) => {
    await mockBackend(page);
    await openGeneratedDocument(page);
    await page.locator(".rail-settings-button").click();
    await page.locator(".settings-nav-item").filter({ hasText: /^助手$|^Assistant$/ }).click();
    const row = page.locator(".settings-row").filter({ hasText: /先想后看|Think first/ });
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await row.getByRole("switch").click();
    await page.keyboard.press("Escape");
    await goToPageTwo(page);
    await expect(page.locator(".notes-content")).toContainText(PAGE_TWO_NOTES);
    await expect(page.locator(".think-first")).toHaveCount(0);
  });
});

test.describe("Think-first rules", () => {
  const pageOfType = (pageType?: string) => ({ page_no: 1, source: { page_type: pageType }, teaching: {} }) as unknown as PageData;

  test("without a lesson plan, covers, outlines and blank pages open directly; the sample pack never gates", () => {
    expect(thinkFirstApplies({ enabled: true, hasDocument: true, plan: undefined, page: pageOfType("title") })).toBe(false);
    expect(thinkFirstApplies({ enabled: true, hasDocument: true, plan: undefined, page: pageOfType("agenda") })).toBe(false);
    expect(thinkFirstApplies({ enabled: true, hasDocument: true, plan: undefined, page: pageOfType("concept") })).toBe(true);
    expect(thinkFirstApplies({ enabled: true, hasDocument: false, plan: undefined, page: pageOfType("concept") })).toBe(false);
    expect(thinkFirstApplies({ enabled: false, hasDocument: true, plan: undefined, page: pageOfType("concept") })).toBe(false);
  });

  test("a prefill never replaces what the learner already typed", () => {
    expect(composerTextWithPrefill("", "我的理解：")).toBe("我的理解：");
    expect(composerTextWithPrefill("为什么 r1 会变", "我的理解：")).toBe("为什么 r1 会变\n我的理解：");
    expect(composerTextWithPrefill("我的理解：", "我的理解：")).toBe("我的理解： ");
  });
});

test.describe("Coaching assistant", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("starters begin with the learner, a coached reply offers the answer on request, and the switch goes direct", async ({ page }) => {
    const chats = await mockBackend(page);
    await uploadPdfFromRail(page);
    const composer = await activateAgent(page);
    await expect(page.locator(".aui-welcome h2")).toHaveText(/先说说你的想法|What do you think/);

    await page.locator(".prompt-suggestions").getByRole("button", { name: /我来讲，你挑毛病|I'll explain, you critique/ }).click();
    await expect(composer).toHaveValue(/我对这一页的理解是：|My understanding of this page:/);
    expect(chats.length).toBe(0);

    await composer.fill("我对这一页的理解是：链接器把目标文件拼起来");
    await page.keyboard.press("Enter");
    await expect.poll(() => chats.length).toBe(1);
    expect(chats[0].answerMode).toBe("coach");
    const direct = page.locator(".direct-answer-button");
    await expect(direct).toBeVisible({ timeout: 10_000 });
    await direct.click();
    await expect.poll(() => chats.length).toBe(2);
    expect(chats[1].input).toContain("直接告诉我答案");

    await page.getByRole("radiogroup", { name: /回答方式|How to answer/ }).getByRole("radio", { name: /直答|Direct/ }).click();
    await composer.fill("什么是重定位？");
    await page.keyboard.press("Enter");
    await expect.poll(() => chats.length).toBe(3);
    expect(chats[2].answerMode).toBe("concise");
    await expect(page.locator(".assistant-message")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator(".direct-answer-button")).toHaveCount(0);
  });

  test("直答 returns to the depth chosen in Settings, and a direct question is never told to hold back", async ({ page }) => {
    const chats = await mockBackend(page);
    await openGeneratedDocument(page);
    await goToPageTwo(page);
    await page.locator(".rail-settings-button").click();
    await page.locator(".settings-nav-item").filter({ hasText: /^助手$|^Assistant$/ }).click();
    await page.locator(".settings-row").filter({ hasText: /助手回答方式|How the assistant answers/ }).locator("select").selectOption("detailed");
    await page.keyboard.press("Escape");

    const composer = await activateAgent(page);
    const toggle = page.getByRole("radiogroup", { name: /回答方式|How to answer/ });
    await toggle.getByRole("radio", { name: /引导|Coach/ }).click();
    await toggle.getByRole("radio", { name: /直答|Direct/ }).click();
    await composer.fill("为什么要用 caller-saved？");
    await page.keyboard.press("Enter");
    await expect.poll(() => chats.length).toBe(1);
    expect(chats[0].answerMode).toBe("detailed");
    // The explanation is still closed, but a direct answer is what was asked for.
    expect("explanationRead" in chats[0]).toBe(false);
  });

  test("“just tell me” is about the conversation and leaves a waiting selection for the next question", async ({ page }) => {
    const chats = await mockBackend(page);
    await uploadPdfFromRail(page);
    const composer = await activateAgent(page);
    await composer.fill("r1 为什么会变？");
    await page.keyboard.press("Enter");
    await expect(page.locator(".direct-answer-button")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator(".pdf-text-layer span", { hasText: "Page One" }).first()).toBeAttached({ timeout: 15_000 });
    await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll<HTMLElement>(".pdf-text-layer span")).find((element) =>
        (element.textContent || "").includes("Page One"),
      )!;
      const range = document.createRange();
      range.selectNodeContents(span);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.locator(".selection-toolbar").getByRole("button", { name: /添加到对话|Add to conversation/ }).click();
    await expect(page.locator(".composer-shell .selected-source-preview")).toContainText("Page One");

    await page.locator(".direct-answer-button").click();
    await expect.poll(() => chats.length).toBe(2);
    expect(chats[1].input).toContain("直接告诉我答案");
    expect(chats[1].selectedContext ?? null).toBeNull();
    await expect(page.locator(".user-message").last().locator(".message-quote")).toHaveCount(0);
    await expect(page.locator(".composer-shell .selected-source-preview")).toContainText("Page One");
  });

  test("a challenge asks for its JSON in a direct mode even while coaching", async ({ page }) => {
    const chats = await mockBackend(page);
    await uploadPdfFromRail(page);
    await activateAgent(page);
    await page.locator(".challenge-start").click();
    await expect.poll(() => chats.length).toBe(1);
    expect(chats[0].answerMode).toBe("concise");
  });

  test("“I'll explain” on a selection puts it in the composer with a sentence to finish", async ({ page }) => {
    const chats = await mockBackend(page);
    await uploadPdfFromRail(page);
    await expect(page.locator(".pdf-text-layer span", { hasText: "Page One" }).first()).toBeAttached({ timeout: 15_000 });
    await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll<HTMLElement>(".pdf-text-layer span")).find((element) =>
        (element.textContent || "").includes("Page One"),
      )!;
      const range = document.createRange();
      range.selectNodeContents(span);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.locator(".selection-toolbar").getByRole("button", { name: /我来解释|I'll explain/ }).click();
    await expect(page.locator(".aui-composer-input")).toHaveValue(/我的理解：|My understanding:/, { timeout: 10_000 });
    await expect(page.locator(".composer-shell .selected-source-preview")).toContainText("Page One");
    expect(chats.length).toBe(0);
  });

  test("preferences saved before coaching existed move to coaching once, and a later choice sticks", async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem("synchropage.uiPreferences.v1", JSON.stringify({ agentAnswerMode: "concise", theme: "dark" }));
    });
    await page.reload();
    await page.waitForSelector(".app-shell");
    await activateAgent(page);
    const toggle = page.getByRole("radiogroup", { name: /回答方式|How to answer/ });
    await expect(toggle.getByRole("radio", { name: /引导|Coach/ })).toHaveAttribute("aria-checked", "true");

    await toggle.getByRole("radio", { name: /直答|Direct/ }).click();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await activateAgent(page);
    await expect(
      page.getByRole("radiogroup", { name: /回答方式|How to answer/ }).getByRole("radio", { name: /直答|Direct/ }),
    ).toHaveAttribute("aria-checked", "true");
  });
});
