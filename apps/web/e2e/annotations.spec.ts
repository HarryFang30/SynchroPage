import { test, expect, type Page } from "@playwright/test";
import { mockApi, resetStorage, uploadPdfFromRail } from "./helpers";

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
