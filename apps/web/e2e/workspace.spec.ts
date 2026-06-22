import { test, expect } from "@playwright/test";
import { createCourse, openRailActionMenu, readFixture, resetStorage, uploadPdfFromRail } from "./helpers";

test.describe("Workspace", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("can create a course", async ({ page }) => {
    await createCourse(page, "E2E Test Course");
    await expect(page.locator(".rail-header")).toContainText("E2E Test Course");
  });

  test("sidebar renders document rail", async ({ page }) => {
    await expect(page.locator(".page-rail")).toBeVisible();
    await expect(page.locator(".rail-top")).toBeVisible();
    await expect(page.locator(".rail-section").first()).toContainText(/课程|Courses/i);
  });

  test("can upload a PDF via sidebar", async ({ page }) => {
    await uploadPdfFromRail(page);

    const documentItem = page.locator(".document-item").filter({ hasText: "two-page" });
    await expect(documentItem).toBeVisible();
    await expect(documentItem).toContainText(/2\s*(页|pages?)/i, { timeout: 10_000 });
    await expect(page.locator(".pdf-js-viewer")).toBeVisible({ timeout: 10_000 });
  });

  test("can upload multiple PDFs into the current course in natural title order", async ({ page }) => {
    await createCourse(page, "Batch Course");
    await openRailActionMenu(page);
    const pdfInput = page.locator('.rail-action-menu input[type="file"][accept="application/pdf"]');
    await expect(pdfInput).toHaveAttribute("multiple", "");

    const pdf = readFixture("two-page.pdf");
    await pdfInput.setInputFiles([
      { name: "batch-10.pdf", mimeType: "application/pdf", buffer: pdf },
      { name: "batch-2.pdf", mimeType: "application/pdf", buffer: pdf },
    ]);

    const documents = page.locator(".document-list .document-item");
    await expect(documents).toHaveCount(2, { timeout: 10_000 });
    await expect(documents.nth(0)).toContainText("batch-2");
    await expect(documents.nth(1)).toContainText("batch-10");
    await expect(documents.nth(0)).toHaveClass(/active/);
    await expect(page.locator(".course-item").filter({ hasText: "Batch Course" })).toContainText(
      /2\s*(个文档|documents?)/i,
    );
  });

  test("asks for confirmation before deleting a document", async ({ page }) => {
    await uploadPdfFromRail(page);

    const documentItem = page.locator(".document-item").filter({ hasText: "two-page" });
    await expect(documentItem).toBeVisible();
    await documentItem.hover();
    await documentItem.locator(".rail-delete-button").click();

    const dialog = page.locator(".rail-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/删除文档|Delete/i);
    await page.getByRole("button", { name: /取消|Cancel/i }).click();
    await expect(dialog).toBeHidden();
    await expect(documentItem).toBeVisible();

    await documentItem.hover();
    await documentItem.locator(".rail-delete-button").click();
    await page.getByRole("button", { name: /^删除$|^Delete$/i }).click();
    await expect(dialog).toBeHidden();
    await expect(documentItem).toHaveCount(0);
  });

  test("asks for confirmation before deleting a course", async ({ page }) => {
    await createCourse(page, "Delete Me");

    const courseItem = page.locator(".course-item").filter({ hasText: "Delete Me" });
    await expect(courseItem).toBeVisible();
    await courseItem.hover();
    await courseItem.locator(".rail-delete-button").click();

    const dialog = page.locator(".rail-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/删除课程|Delete/i);
    await page.getByRole("button", { name: /取消|Cancel/i }).click();
    await expect(dialog).toBeHidden();
    await expect(courseItem).toBeVisible();

    await courseItem.hover();
    await courseItem.locator(".rail-delete-button").click();
    await page.getByRole("button", { name: /^删除$|^Delete$/i }).click();
    await expect(dialog).toBeHidden();
    await expect(courseItem).toHaveCount(0);
  });
});
