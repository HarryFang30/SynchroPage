import { test, expect } from "@playwright/test";
import { createCourse, resetStorage, uploadPdfFromRail } from "./helpers";

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
});
