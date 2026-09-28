import { test, expect, type Page, type Route } from "@playwright/test";
import { resetStorage, uploadPdfFromRail } from "./helpers";

const PAGE_ONE_NOTES = "第 7 讲，链接。";

function generatedPage(pageNo: number) {
  return {
    page_no: pageNo,
    teaching: {
      slide_title: pageNo === 1 ? "Lecture 7" : "Leaf functions",
      speaker_notes_md: pageNo === 1
        ? PAGE_ONE_NOTES
        : "叶函数体内没有调用点，所以没有需要跨调用保住的值。These mocked notes are long enough to pass every quality floor.",
      question: pageNo === 1 ? "" : "为什么叶函数里的 caller-saved 寄存器可以不保存？",
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

async function mockGeneration(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/api/generate/plan")) return json(plan);
    if (url.includes("/api/generate/pages")) return json({ pages: [generatedPage(1), generatedPage(2)] });
    if (url.includes("/api/generate/page")) {
      const body = route.request().postDataJSON() as { page?: { page_no?: number } };
      return json({ page: generatedPage(body.page?.page_no || 1) });
    }
    return json({});
  });
}

const pageNav = (page: Page) => page.locator(".topbar-page-nav");

/** The page whose box the viewer's 50% line crosses: what the reader actually sees. */
function pageUnderReadingLine(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".pdf-js-viewer")!;
    const rootRect = root.getBoundingClientRect();
    const lineY = rootRect.top + rootRect.height * 0.5;
    const hit = Array.from(document.querySelectorAll<HTMLElement>(".pdf-page-shell")).find((shell) => {
      const rect = shell.getBoundingClientRect();
      return rect.top <= lineY && rect.bottom >= lineY;
    });
    return Number(hit?.dataset.pageContainerNumber || 0);
  });
}

/** The counter and the viewer reach the page, and are still there once any pending restore would have fired. */
async function expectToLandOn(page: Page, pageNo: number, pageCount: number) {
  const output = pageNav(page).locator("output");
  await expect.poll(() => output.innerText(), { intervals: [400], timeout: 4_000 }).toContain(`${pageNo} / ${pageCount}`);
  await expect.poll(() => pageUnderReadingLine(page), { timeout: 4_000 }).toBe(pageNo);
  await page.waitForTimeout(700);
  await expect(output).toContainText(`${pageNo} / ${pageCount}`);
  expect(await pageUnderReadingLine(page)).toBe(pageNo);
}

test.describe("A page turn in the first moments of a document lands", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    await mockGeneration(page);
  });

  test("the next page opens right after a one-click generation with a lesson plan finishes", async ({ page }) => {
    await uploadPdfFromRail(page);
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await page.locator(".generate-main-button").click();
    await expect(page.locator(".notes-content")).toContainText(PAGE_ONE_NOTES, { timeout: 15_000 });

    await pageNav(page).getByRole("button", { name: /下一页|Next page/i }).click();
    await expectToLandOn(page, 2, 2);
    await expect(page.locator(".pdf-page-shell[data-page-container-number='2'] .pdf-page-label")).toContainText("★");
  });

  test("a page turn made while the viewer is still restoring the saved page is not undone", async ({ page }) => {
    await uploadPdfFromRail(page);
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    // Setup only: the upload's own restore is done before this turn, so what
    // is tested is the turn after the reload.
    await page.waitForTimeout(600);
    await pageNav(page).getByRole("button", { name: /下一页|Next page/i }).click();
    await expectToLandOn(page, 2, 2);
    // Past the reading-position autosave.
    await page.waitForTimeout(1_200);

    await page.reload();
    // The restore to page 2 is scheduled as the pages mount; turn back before it has run.
    await page.locator(".pdf-page-shell").first().waitFor({ timeout: 15_000 });
    await pageNav(page).getByRole("button", { name: /上一页|Previous page/i }).click();
    await expectToLandOn(page, 1, 2);
  });
});
