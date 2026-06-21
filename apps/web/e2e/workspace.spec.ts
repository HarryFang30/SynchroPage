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

  test("can upload multiple PDFs into the current course", async ({ page }) => {
    await createCourse(page, "Batch Course");
    await openRailActionMenu(page);
    const pdfInput = page.locator('.rail-action-menu input[type="file"][accept="application/pdf"]');
    await expect(pdfInput).toHaveAttribute("multiple", "");

    const pdf = readFixture("two-page.pdf");
    await pdfInput.setInputFiles([
      { name: "batch-first.pdf", mimeType: "application/pdf", buffer: pdf },
      { name: "batch-second.pdf", mimeType: "application/pdf", buffer: pdf },
    ]);

    const firstDocument = page.locator(".document-item").filter({ hasText: "batch-first" });
    const secondDocument = page.locator(".document-item").filter({ hasText: "batch-second" });
    await expect(firstDocument).toBeVisible({ timeout: 10_000 });
    await expect(secondDocument).toBeVisible({ timeout: 10_000 });
    await expect(secondDocument).toHaveClass(/active/);
    await expect(page.locator(".course-item").filter({ hasText: "Batch Course" })).toContainText(
      /2\s*(个文档|documents?)/i,
    );
  });
});
